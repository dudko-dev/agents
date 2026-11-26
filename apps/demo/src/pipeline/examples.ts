import type { PipelineDefinition } from '@dudko.dev/agent-web-react/pipeline'

/** The pipelines the page offers to start from. The first one is loaded on a first visit. */
export interface PipelineExample {
  id: string
  label: string
  /** A request that shows what the pipeline is for; it fills the run bar. */
  request: string
  definition: PipelineDefinition
}

export const EXAMPLES: PipelineExample[] = [
  {
    id: 'review-loop',
    label: 'Writer and reviewer (a loop)',
    request: 'A release note for v2: pipelines, a graph of agents with conditions and loops',
    definition: {
      version: 1,
      name: 'Write, review, publish',
      entry: 'writer',
      nodes: [
        {
          id: 'writer',
          name: 'Writer',
          instructions:
            'Write the text the request asks for. If a reviewer sent notes, rewrite the text so that every note is addressed. Reply with the text only.',
          position: { x: 0, y: 40 },
        },
        {
          id: 'reviewer',
          name: 'Reviewer',
          instructions:
            'Review the text against the request. Be strict and concrete: list what must change, or say that it is ready.',
          routes: [
            { label: 'approved', description: 'the text is ready to publish as it is' },
            { label: 'revise', description: 'the text needs another pass' },
          ],
          position: { x: 380, y: 0 },
        },
        {
          id: 'publisher',
          name: 'Publisher',
          instructions:
            'Format the approved text for publication: a title, short paragraphs, no commentary.',
          position: { x: 760, y: 40 },
        },
      ],
      edges: [
        { id: 'e0', from: 'writer', to: 'reviewer' },
        { id: 'e1', from: 'reviewer', to: 'publisher', when: { kind: 'route', label: 'approved' } },
        { id: 'e2', from: 'reviewer', to: 'writer', when: { kind: 'otherwise' } },
      ],
      limits: { maxNodeVisits: 3 },
    },
  },
  {
    id: 'research',
    label: 'Research (fan-out and fan-in)',
    request: 'Should a small team adopt a monorepo?',
    definition: {
      version: 1,
      name: 'Research from three angles',
      entry: 'planner',
      nodes: [
        {
          id: 'planner',
          name: 'Planner',
          instructions:
            'Restate the question precisely and list the three or four things that decide the answer.',
          position: { x: 0, y: 180 },
        },
        {
          id: 'advocate',
          name: 'Advocate',
          instructions: 'Make the strongest honest case FOR. Concrete benefits, with conditions.',
          position: { x: 380, y: 0 },
        },
        {
          id: 'skeptic',
          name: 'Skeptic',
          instructions:
            'Make the strongest honest case AGAINST. Concrete costs, risks and failure modes.',
          position: { x: 380, y: 180 },
        },
        {
          id: 'practitioner',
          name: 'Practitioner',
          instructions:
            'Describe what doing it takes in practice: the first week, the tooling, what breaks.',
          position: { x: 380, y: 360 },
        },
        {
          id: 'editor',
          name: 'Editor',
          instructions:
            'Weigh the three views and answer the question: a recommendation, the conditions under which it flips, and the first step.',
          join: 'all',
          position: { x: 760, y: 180 },
        },
      ],
      edges: [
        { id: 'e0', from: 'planner', to: 'advocate' },
        { id: 'e1', from: 'planner', to: 'skeptic' },
        { id: 'e2', from: 'planner', to: 'practitioner' },
        { id: 'e3', from: 'advocate', to: 'editor' },
        { id: 'e4', from: 'skeptic', to: 'editor' },
        { id: 'e5', from: 'practitioner', to: 'editor' },
      ],
    },
  },
  {
    id: 'router',
    label: 'Router (three branches)',
    request: 'I was charged twice for my subscription this month.',
    definition: {
      version: 1,
      name: 'Support triage',
      entry: 'triage',
      nodes: [
        {
          id: 'triage',
          name: 'Triage',
          instructions:
            'Read the customer message and say in one sentence what it is about and how urgent it is.',
          routes: [
            { label: 'billing', description: 'payments, invoices, refunds, plans' },
            { label: 'technical', description: 'something does not work, an error, a bug' },
            { label: 'other', description: 'anything else' },
          ],
          position: { x: 0, y: 130 },
        },
        {
          id: 'billing',
          name: 'Billing',
          instructions:
            'Answer as the billing desk: what happened, what you will do, what the customer should check. Never promise a refund you cannot see.',
          position: { x: 400, y: 0 },
        },
        {
          id: 'technical',
          name: 'Technical',
          instructions:
            'Answer as support engineering: the likely cause, the steps to try in order, what to send back if they fail.',
          position: { x: 400, y: 170 },
        },
        {
          id: 'general',
          name: 'General',
          instructions: 'Answer politely and briefly, and say who can help further.',
          position: { x: 400, y: 340 },
        },
      ],
      edges: [
        { id: 'e0', from: 'triage', to: 'billing', when: { kind: 'route', label: 'billing' } },
        { id: 'e1', from: 'triage', to: 'technical', when: { kind: 'route', label: 'technical' } },
        { id: 'e2', from: 'triage', to: 'general', when: { kind: 'otherwise' } },
      ],
    },
  },
]

export const STARTER = EXAMPLES[0]
