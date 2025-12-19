import os
import sys
import json
from flask import Flask, make_response, send_file
from flask_socketio import SocketIO, emit
from uuid import uuid4
import lmstudio as lms


CHARACTERS_FILE = os.getenv("CHARACTERS_FILE", "characters.json")
TREE_FILE = os.getenv("TREE_FILE", "tree.json")


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

    with open(CHARACTERS_FILE) as f:
        characters = json.load(f)

    prompt = ""
    for c_name in characters:
        character = characters[c_name]
        if not "traits" in character:
            continue

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
    with open(TREE_FILE, "w") as f:
        json.dump(tree, f, indent=2)
    print("Saved dialogue tree.")


def send_regen_complete(nid):
    emit(
        "regen_complete",
        {
            "nid": nid,
            "text": tree[nid]["text"],
        },
        broadcast=True,
    )


app = Flask(__name__)
socketio = SocketIO(app, cors_allowed_origins="*")
model = lms.llm(characters["System"]["model"])

if not tree:
    prompt = build_prompt()
    build_node("System", prompt, None)
    save_tree_file()


@app.route("/", methods=["GET"])
def index_html():
    try:
        return send_file("index.html")
    except Exception as e:
        return make_response(f"Err: {str(e)}", 500)


@app.route("/index.css", methods=["GET"])
def index_css():
    try:
        return send_file("index.css")
    except Exception as e:
        return make_response(f"Err: {str(e)}", 500)


@app.route("/index.js", methods=["GET"])
def index_js():
    try:
        return send_file("index.js")
    except Exception as e:
        return make_response(f"Err: {str(e)}", 500)


@socketio.on("connect")
def on_connect():
    print("Client connected.")

    emit(
        "load",
        {
            "characters": characters,
            "tree": tree,
        },
    )


@socketio.on("edit_node")
def edit_node(data):
    nid = data["nid"]
    tree[nid] = data
    save_tree_file()


@socketio.on("delete_node")
def delete_node(data):
    nid = data["nid"]
    if nid not in tree:
        return
    del tree[nid]
    save_tree_file()


@socketio.on("regen_node")
def regen_node(data):
    nid = data["nid"]
    extend = data["extend"]
    if nid not in tree:
        print(f"Node {nid} not found for regeneration.")
        return

    parent = tree[nid]["parent"]

    if parent is None:
        tree[nid]["text"] = build_prompt()
        save_tree_file()
        send_regen_complete(nid)
        return

    log = build_chat_log(parent)
    log += f"{tree[nid]["sender"]}:"

    if extend:
        log += f" {tree[nid]["text"]}"

    tokens = len(model.tokenize(log))
    max_tokens = model.get_context_length()

    print("=" * 100)
    print(f"Regenerating node: {nid} ({tokens}/{max_tokens} tokens)")
    print("-" * 100)
    print(log, end=" ", flush=True)

    result = model.complete(
        log, config={"maxTokens": 256, "stopStrings": ["\n"], "temperature": 0.7}
    )

    text = result.content.strip()
    print(text)
    print("-" * 100)

    gen_tokens = result.stats.predicted_tokens_count
    if gen_tokens == 0:
        gen_time = result.stats.time_to_first_token_sec
    else:
        gen_time = (
            gen_tokens / result.stats.tokens_per_second
            + result.stats.time_to_first_token_sec
        )

    print(f"Generated {gen_tokens} tokens in {gen_time:.1f} seconds.")
    print("=" * 100)

    if extend:
        text = tree[nid]["text"] + " " + text

    tree[nid]["text"] = text
    save_tree_file()
    send_regen_complete(nid)
