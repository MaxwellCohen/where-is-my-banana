/** Agent prompt that captures a Next.js analyze graph and loads it into this visualizer. */
export function buildAgentPrompt(visualizerUrl: string): string {
  const url = visualizerUrl.replace(/\/$/, "");
  return `Build a WIMB bundle-forest graph for this Next.js App Router project and open it in the hosted visualizer.

Do not upgrade the app's \`next\` version.

## Steps

Run everything from the project root (Node >= 20). WIMB runs from GitHub via npx; do not clone it or install anything.

1. Capture the Turbopack module graph and a JSONL export (no package.json changes):

\`\`\`bash
mkdir -p .wimb
npx next analyze --output --snapshot wimb
npx next analyze export --snapshot wimb > .wimb/graph.jsonl
\`\`\`

Older Next (16.1-16.3) has no \`analyze export\`: use \`npx next experimental-analyze --output\` and skip \`--analyze-export\` below.

2. Build the forest and the ranked wins:

\`\`\`bash
npx --yes github:MaxwellCohen/where-is-my-banana#npx viz build --analyze-export .wimb/graph.jsonl -o .wimb/bundle-graph.json
npx --yes github:MaxwellCohen/where-is-my-banana#npx wins --analyze-export .wimb/graph.jsonl --cwd .
\`\`\`

Outputs \`.wimb/bundle-graph.json\` and \`.wimb/wins.json\`. Add \`.wimb/\` to \`.gitignore\`. Optional: \`--async\` on \`viz build\` includes dynamic import edges.

3. Open the visualizer and open the graph **locally in the browser** (nothing is uploaded to the host):

- URL: ${url}
- Click **Open local file**
- Choose \`.wimb/bundle-graph.json\` from this project (parsed client-side only)
- Click **Open wins.json** and choose \`.wimb/wins.json\`

Privacy: do not POST the graph to any API, gist, or chat attachment unless the user explicitly asks. The hosted app has no server upload endpoint.

## Success criteria

- Hosted page starts blank until the local JSON is opened
- Visualizer shows this project's routes
- Client / Server filter and Sorted files view work
- Brief summary of the heaviest app files by "pulls in" weight on the default route
`;
}
