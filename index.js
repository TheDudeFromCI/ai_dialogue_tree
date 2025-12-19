import { marked } from "https://cdn.jsdelivr.net/npm/marked/lib/marked.esm.js"

const NODE_HEIGHT = 200
const NODE_WIDTH = 300
const NODE_H_MARGIN = 20
const NODE_V_MARGIN = 75
const NODE_PADDING = 18 // padding top/bottom + border top/bottom
const SVG_PADDING = 2
const TICKER_SPEED = 200

const TICKER_VALUES = [
    ".....",
    "o....",
    "Oo...",
    "oOo..",
    ".oOo.",
    "..oOo",
    "...oO",
    "....o",
]

const socket = io()
let tree = {}
let characters = {}
let ticker = 0
let isGenerating = false
let generationAnimationTimer = null


socket.on("characters", c => {
    characters = c
})


socket.on("tree_update", t => {
    tree = t
    isGenerating = false
    
    let root = get_root()
    recalculateSizes(root)

    root.x = document.documentElement.clientWidth / 2 - NODE_WIDTH / 2
    root.y = 20

    if (root.x - root.size / 2 < 0)
        root.x = root.size / 2 - NODE_WIDTH / 2

    recalculatePositions(root)
    root.x -= NODE_WIDTH / 2

    render()
})


function get_root() {
    for (const nid in tree) tree[nid].isRoot = false

    for (const nid in tree) {
        if (tree[nid].parent == null) {
            tree[nid].isRoot = true
            return tree[nid]
        }
    }
    console.error("Failed to find root node!")
}


function recalculateSizes(node) {
    let childSize = (node.children.length - 1) * NODE_H_MARGIN
    for (const cid of node.children) {
        let child = tree[cid]
        childSize += recalculateSizes(child)
    }

    node.size = Math.max(childSize, NODE_WIDTH)
    return node.size
}


function recalculatePositions(node) {
    let posX = node.x - node.size / 2
    let posY = node.y + NODE_HEIGHT + NODE_V_MARGIN

    for (const cid of node.children) {
        let child = tree[cid]
        child.x = posX + child.size / 2
        child.y = posY
        recalculatePositions(child)

        posX += child.size + NODE_H_MARGIN
    }
}


function render() {
    document.querySelectorAll(".node").forEach(n => n.remove())
    document.querySelectorAll("svg").forEach(n => n.remove())

    for (const id in tree) {
        const n = tree[id]
        if (n.parent) drawLine(n, tree[n.parent])
        makeNode(n)
    }
}


function getColor(node) {
    return characters[node.sender]?.color ?? "#000000"
}


function drawLine(child, parent) {
    let nodeWidth = parent.isRoot ? NODE_WIDTH * 2 : NODE_WIDTH
    let nSiblings = parent.children.length
    let childIndex = parent.children.findIndex(id => id == child.nid)
    let offset = nodeWidth / (nSiblings + 1) * (childIndex + 1)

    let x1 = parent.x + offset
    let y1 = parent.y + NODE_HEIGHT + NODE_PADDING
    let x2 = child.x + NODE_WIDTH / 2
    let y2 = child.y

    let width = Math.max(x1, x2) - Math.min(x1, x2) + SVG_PADDING * 2
    let height = y2 - y1 + SVG_PADDING * 2
    let left = Math.min(x1, x2) - SVG_PADDING
    let top = y1 - SVG_PADDING

    x1 -= left
    x2 -= left
    y1 -= top
    y2 -= top

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
    svg.setAttribute('style', `left: ${left}px; top: ${top}px`);
    svg.setAttribute('width', width)
    svg.setAttribute('height', height)
    svg.setAttributeNS("http://www.w3.org/2000/xmlns/", "xmlns:xlink", "http://www.w3.org/1999/xlink")

    const line = document.createElementNS("http://www.w3.org/2000/svg", "path")
    line.setAttributeNS(null, "d", `M ${x1} ${y1} C ${x1} ${y2}, ${x2} ${y1}, ${x2} ${y2}`);
    line.setAttribute("stroke", "#bbbbbb")
    line.setAttribute("stroke-width", 3)
    line.setAttribute("fill", "transparent")
    svg.appendChild(line)

    document.body.appendChild(svg)
}


function makeNode(n) {
    const node = document.createElement("div");

    if (n.isRoot) node.className = "node root"
    else node.className = "node"

    node.style.left = n.x + "px"
    node.style.top = n.y + "px"
    node.style["border-color"] = getColor(n)

    const sender = document.createElement("select")
    sender.innerHTML = Object
        .keys(characters)
        .map(name => `<option value="${name}">${name}</option>`)
        .join()
    sender.value = n["sender"]

    const text = document.createElement("textarea")
    text.value = n.text
    
    const textDisplay = document.createElement("div")
    textDisplay.className = "textdisplay"
    textDisplay.contenteditable = true
    textDisplay.innerHTML = marked.parse(n.text)

    node.append(sender, text, textDisplay)

    if (n.isRoot) {
        text.style.display = 'block'
        textDisplay.style.display = 'none'
    }

    sender.onchange = () => {
        if (isGenerating) return

        n.sender = sender.value
        node.style["border-color"] = getColor(n)

        socket.emit("edit_node", {
            nid: n.nid,
            sender: sender.value,
            text: text.value,
        })
    }

    text.onchange = () => {
        if (isGenerating) return

        n.text = text.value
        textDisplay.innerHTML = marked.parse(text.value)

        socket.emit("edit_node", {
            nid: n.nid,
            sender: sender.value,
            text: text.value,
        })
    }

    if (!n.isRoot) {
        text.addEventListener("blur", () => {
            if (isGenerating) return

            textDisplay.style.display = 'block'
            text.style.display = 'none'
        })

        textDisplay.addEventListener("click", () => {
            if (isGenerating) return

            textDisplay.style.display = 'none'
            text.style.display = 'block'
            text.focus()
        })
    }

    const buttons = document.createElement("div")
    buttons.className = "buttons"

    const child = btn("Child", () => {
        if (isGenerating) return

        socket.emit("create_node", {
            parent: n.nid
        })
    })

    const del = btn("Delete", () => {
        if (isGenerating) return

        socket.emit("delete_node", {
            nid: n.nid
        })
    })

    const clone = btn("Clone", () => {
        if (isGenerating) return

        socket.emit("clone_node", {
            nid: n.nid
        })
    })

    const regen = btn("Regen", () => {
        regen_func(n, textDisplay, "regen_node")
    })

    const regen_cont = btn("Continue", () => {
        regen_func(n, textDisplay, "regen_cont_node")
    })

    if (n.parent == null) {
        buttons.append(child, regen)
    } else {
        buttons.append(clone, del, child, regen, regen_cont)
    }

    node.append(buttons)
    document.body.appendChild(node)
}


function regen_func(n, textDisplay, ev) {
    if (isGenerating) return

    ticker = 0
    isGenerating = true

    if (generationAnimationTimer != null)
        clearInterval(generationAnimationTimer)

    document.querySelectorAll(".node *").forEach(n => n.disabled = true)

    generationAnimationTimer = setInterval(() => {
        if (!isGenerating) {
            clearInterval(generationAnimationTimer)
            generationAnimationTimer = null
            return
        }

        textDisplay.innerHTML = `<p class="ticker">${TICKER_VALUES[ticker]}</p>`
        ticker = (ticker + 1) % TICKER_VALUES.length
    }, TICKER_SPEED)

    socket.emit(ev, {
        nid: n.nid
    })
}


function btn(label, fn) {
    const b = document.createElement("button")
    b.textContent = label
    b.onclick = fn
    return b
}
