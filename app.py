import os
import sys
import json
from flask import Flask, make_response, send_file
from flask_socketio import SocketIO, emit
from uuid import uuid4
import lmstudio as lms


CHARACTERS_FILE = os.getenv("CHARACTERS_FILE", "characters.json")
TREE_FILE = os.getenv("TREE_FILE", "tree.json")
LM_STUDIO_URL = os.getenv("LM_STUDIO_URL", "http://localhost:1234")
LM_STUDIO_MODEL = os.getenv("LM_STUDIO_MODEL", "model")
LM_STUDIO_TEMP = float(os.getenv("LM_STUDIO_TEMP", "0.7"))
LM_STUDIO_MAX_TOKENS = int(os.getenv("LM_STUDIO_MAX_TOKENS", "256"))


def load_characters():
    global characters

    try:
        with open(CHARACTERS_FILE) as f:
            characters = json.load(f)
    except Exception as e:
        print(f"Error loading characters file: {str(e)}")
        characters = {}

    characters.setdefault("System", {})


def load_tree():
    global tree

    try:
        with open(TREE_FILE) as f:
            tree = json.load(f)
    except FileNotFoundError:
        tree = {}
    except Exception as e:
        print(f"Error loading tree file: {str(e)}")
        sys.exit(1)

    if not tree:
        nid = str(uuid4())
        tree[nid] = {
            "nid": nid,
            "sender": "System",
            "text": build_prompt(),
            "parent": None,
            "children": [],
        }
        save_tree_file()


def build_prompt():
    global characters
    load_characters()

    prompt = ""
    for c_name in characters:
        character = characters[c_name]
        if not "traits" in character:
            continue

        prompt += f"[\n"
        prompt += f'  name: "{c_name}"\n'

        for trait in character["traits"]:
            value = character["traits"][trait]
            if isinstance(value, list):
                value = " + ".join(f'"{str(x)}"' for x in value)
            else:
                value = f'"{str(value)}"'

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
    try:
        with open(TREE_FILE, "w") as f:
            json.dump(tree, f, indent=2)
        print("Saved dialogue tree.")
    except Exception as e:
        print(f"Error saving tree file: {str(e)}")


def send_regen_complete(nid):
    emit(
        "regen_complete",
        {
            "nid": nid,
            "text": tree[nid]["text"],
        },
        broadcast=True,
    )


load_characters()
load_tree()

app = Flask(__name__)
socketio = SocketIO(app, cors_allowed_origins="*")

lms.configure_default_client(LM_STUDIO_URL)
model = lms.llm(LM_STUDIO_MODEL)
lms.set_sync_api_timeout(600)


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

    if tree[nid]["sender"] != "System":
        log += f"{tree[nid]["sender"]}:"
    existing_text = tree[nid]["text"].strip()

    if extend:
        log += f" {existing_text}"

    tokens = len(model.tokenize(log))
    max_tokens = model.get_context_length()

    print(f"{nid}: Regenerating node ({tokens}/{max_tokens} tokens)")

    result = None
    text = ""
    for _ in range(10):
        try:
            result = model.complete(
                log,
                config={
                    "maxTokens": LM_STUDIO_MAX_TOKENS,
                    "stopStrings": ["\n"],
                    "temperature": LM_STUDIO_TEMP,
                },
            )
        except Exception as e:
            print(f"{nid} Generation error: {str(e)}. Retrying...")
            continue

        text = result.content.strip()
        if text != "":
            break

    if text == "":
        print(f"{nid} Failed to generate. Giving up.")
        send_regen_complete(nid)
        return

    gen_tokens = result.stats.predicted_tokens_count
    gen_time = (
        gen_tokens / result.stats.tokens_per_second
        + result.stats.time_to_first_token_sec
    )

    print(f"{nid}: Generated {gen_tokens} tokens in {gen_time:.1f} seconds.")

    if extend:
        text = f"{existing_text}  {text}"

    tree[nid]["text"] = text
    save_tree_file()
    send_regen_complete(nid)
