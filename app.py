import os
import sys
import json
from flask import Flask, make_response, send_file
from flask_socketio import SocketIO, emit
from uuid import uuid4
import lmstudio as lms


CHARACTERS_FILE = os.getenv("CHARACTERS_FILE", 'characters.json')
TREE_FILE = os.getenv("TREE_FILE", 'tree.json')

with open(CHARACTERS_FILE) as f:
    characters = json.load(f)

with open(TREE_FILE) as f:
    tree = json.load(f)


def build_node(sender, text, parent):
    nid = str(uuid4()) 

    tree[nid] = {
        "nid": nid,
        "sender": sender,
        "text": text,
        "parent": parent,
        "children": [],
    }

    if parent is not None:
        tree[parent]["children"].append(nid)

    return nid


def build_prompt():
    global characters

    prompt = ""
    for c_name in characters:
        character = characters[c_name]
        if not "traits" in character: continue

        prompt += f"[\n"
        prompt += f"  name: {c_name}\n"

        for trait in character["traits"]:
            value = character["traits"][trait]
            if isinstance(value, list):
                value = " + ".join(str(x) for x in value)
            else:
                value = str(value)

            prompt += f"  {trait}: {value}\n"
        prompt += "]\n\n"

    if "context" in characters["System"]:
        prompt += f"***\n{characters["System"]["context"]}\n"

    prompt += "***\n<START>"
    return prompt


def build_chat_log(nid):
    global tree

    log = ""
    while nid is not None:
        node = tree[nid]

        if node["sender"] == "System":
            log = f"{node["text"]}\n{log}"
        else:
            log = f"{node["sender"]}: {node["text"]}\n{log}"

        nid = node["parent"]

    return log


def save_tree_file():
    with open(TREE_FILE, 'w') as f:
        json.dump(tree, f, indent=2)
    print("Saved dialogue tree.")


def save_and_emit():
    save_tree_file()
    emit("tree_update", tree, broadcast=True)


app = Flask(__name__)
socketio = SocketIO(app, cors_allowed_origins="*")
model = lms.llm(characters["System"]["model"])

if not tree:
    prompt = build_prompt()
    build_node("System", prompt, None)
    save_tree_file()


@app.route("/", methods=['GET'])
def index_html():
    try:
        return send_file("index.html")
    except Exception as e:
        return make_response(f"Err: {str(e)}", 500)


@app.route("/index.css", methods=['GET'])
def index_css():
    try:
        return send_file("index.css")
    except Exception as e:
        return make_response(f"Err: {str(e)}", 500)


@app.route("/index.js", methods=['GET'])
def index_js():
    try:
        return send_file("index.js")
    except Exception as e:
        return make_response(f"Err: {str(e)}", 500)


@socketio.on("connect")
def on_connect():
    print("Client connected.")

    emit("characters", characters)
    emit("tree_update", tree)


@socketio.on("create_node")
def create_node(data):
    parent = data["parent"]
    if parent is None:
        return

    print(f"Creating child node for {parent}")

    build_node("Sender", "Text", parent)
    save_and_emit()


@socketio.on("edit_node")
def edit_node(data):
    nid = data["nid"]
    tree[nid]["sender"] = data["sender"]
    tree[nid]["text"] = data["text"]

    save_tree_file()


@socketio.on("delete_node")
def delete_node(data):
    nid = data["nid"]
    parent = tree[nid]["parent"]

    if parent is None:
        return

    print(f"Deleting node: {nid}")
    tree[parent]["children"].remove(nid)

    def delete_recursive(n):
        for c in tree[n]["children"]:
            delete_recursive(c)
        del tree[n]

    delete_recursive(nid)
    save_and_emit()


@socketio.on("clone_node")
def clone_node(data):
    nid = data["nid"]

    if tree[nid]["parent"] is None:
        return

    print(f"Cloning node: {nid}")

    def clone_recursive(n, parent):
        node = build_node(tree[n]["sender"], tree[n]["text"], parent)

        for cid in tree[n]["children"]:
            clone_recursive(cid, node)

    clone_recursive(nid, tree[nid]["parent"])
    save_and_emit()


@socketio.on("regen_node")
def regen_node(data):
    nid = data["nid"]
    parent = tree[nid]["parent"]

    if parent is None:
        tree[nid]["text"] = build_prompt()
        emit("tree_update", tree, broadcast=True)
        return

    log = build_chat_log(parent)
    log += f"{tree[nid]["sender"]}:"

    tokens = len(model.tokenize(log))
    max_tokens = model.get_context_length()

    print("=" * 100)
    print(f"Regenerating node: {nid} ({tokens}/{max_tokens} tokens)")
    print("-" * 100)
    print(log, end=' ', flush=True)

    result = model.complete(log, config={
        "maxTokens": 256,
        "stopStrings": ["\n"],
        "temperature": 0.7
    })

    text = result.content.strip()
    print(text)
    print("-" * 100)

    gen_tokens = result.stats.predicted_tokens_count
    gen_time = gen_tokens / result.stats.tokens_per_second + result.stats.time_to_first_token_sec
    print(f"Generated {gen_tokens} tokens in {gen_time:.1f} seconds.")
    print("=" * 100)

    tree[nid]["text"] = text
    save_and_emit()


@socketio.on("regen_cont_node")
def regen_cont_node(data):
    nid = data["nid"]
    parent = tree[nid]["parent"]

    if parent is None:
        tree[nid]["text"] = build_prompt()
        emit("tree_update", tree, broadcast=True)
        return

    log = build_chat_log(parent)
    log += f"{tree[nid]["sender"]}: {tree[nid]["text"]}"

    tokens = len(model.tokenize(log))
    max_tokens = model.get_context_length()

    print("=" * 100)
    print(f"Extending node: {nid} ({tokens}/{max_tokens} tokens)")
    print("-" * 100)
    print(log, end=' ', flush=True)

    result = model.complete(log, config={
        "maxTokens": 256,
        "stopStrings": ["\n"],
        "temperature": 0.7
    })

    text = result.content.strip()
    print(text)
    print("-" * 100)

    gen_tokens = result.stats.predicted_tokens_count
    gen_time = gen_tokens / result.stats.tokens_per_second + result.stats.time_to_first_token_sec
    print(f"Generated {gen_tokens} tokens in {gen_time:.1f} seconds.")
    print("=" * 100)

    tree[nid]["text"] += f" {text}"
    save_and_emit()
