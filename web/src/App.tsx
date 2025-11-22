import NodeGraph from './components/NodeGraph'

export default function App () {
    return (
        <main class="app-shell">
            <header class="app-shell__header">
                <p class="app-shell__eyebrow">Graph tooling · experimental</p>
                <h1>Visual Node Graph Builder</h1>
                <p>
                    Prototype flows by adding labeled steps, connecting them, and dragging nodes into the layout
                    that makes sense for your workflow.
                </p>
            </header>
            <NodeGraph />
        </main>
    )
}
