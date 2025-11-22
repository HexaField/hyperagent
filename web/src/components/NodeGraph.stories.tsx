import type { Meta, StoryObj } from '@storybook/html'
import { render } from 'solid-js/web'
import NodeGraph, { type GraphEdge, type GraphNode, type NodeGraphProps } from './NodeGraph'

const solidRenderer: Meta<NodeGraphProps>['render'] = (args) => {
  const host = document.createElement('div')
  render(() => <NodeGraph {...args} />, host)
  return host
}

const meta: Meta<NodeGraphProps> = {
  title: 'Components/NodeGraph',
  render: solidRenderer,
  args: {
    width: 860,
    height: 520
  },
  argTypes: {
    width: { control: { type: 'number' } },
    height: { control: { type: 'number' } }
  }
}

export default meta

type Story = StoryObj<NodeGraphProps>

export const Default: Story = {}

const dataPipelineNodes: GraphNode[] = [
  { id: 'ingest', label: 'Ingest', x: 140, y: 120 },
  { id: 'clean', label: 'Clean', x: 360, y: 120 },
  { id: 'transform', label: 'Transform', x: 580, y: 120 },
  { id: 'enrich', label: 'Enrich', x: 360, y: 300 },
  { id: 'serve', label: 'Serve', x: 580, y: 320 }
]

const dataPipelineEdges: GraphEdge[] = [
  { id: 'ingest-clean', from: 'ingest', to: 'clean' },
  { id: 'clean-transform', from: 'clean', to: 'transform' },
  { id: 'transform-enrich', from: 'transform', to: 'enrich' },
  { id: 'enrich-serve', from: 'enrich', to: 'serve' }
]

export const DataPipeline: Story = {
  args: {
    initialNodes: dataPipelineNodes,
    initialEdges: dataPipelineEdges,
    width: 900,
    height: 560
  }
}

const labeledEdges: GraphEdge[] = [
  { id: 'ingest-clean-labeled', from: 'ingest', to: 'clean', label: 'Sanitize payload' },
  { id: 'clean-transform-labeled', from: 'clean', to: 'transform', label: 'Normalize types' },
  { id: 'transform-enrich-labeled', from: 'transform', to: 'enrich', label: 'Annotate records' },
  { id: 'enrich-serve-labeled', from: 'enrich', to: 'serve', label: 'Publish API' }
]

export const LabeledRelationships: Story = {
  args: {
    initialNodes: dataPipelineNodes,
    initialEdges: labeledEdges,
    width: 920,
    height: 560
  }
}
