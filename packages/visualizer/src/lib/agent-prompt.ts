/** Agent prompt that captures a Next.js analyze graph and loads it into this visualizer. */
export function buildAgentPrompt(visualizerUrl: string): string {
  const url = visualizerUrl.replace(/\/$/, "");
  return `Build a WIMB bundle-forest graph for this Next.js App Router project and open it in the hosted visualizer.

Do not upgrade the app's \`next\` version. Prefer whatever analyze CLI this Next already ships.

## Steps

1. From the project root, capture Turbopack analyze artifacts (no package.json changes).

Detect the command (try in order; stop on first success):

\`\`\`bash
# Next where analyze is stable (e.g. 16.4+)
pnpm exec next analyze --output
# Older Next that still uses the experimental alias
pnpm exec next experimental-analyze --output
# same via npx if needed:
# npx next analyze --output
# npx next experimental-analyze --output
\`\`\`

Artifacts land under \`.next/diagnostics/analyze/\`.

Optional richer path when \`next analyze export\` exists (Next 16.4+ graph-v1 JSONL):

\`\`\`bash
SNAP="viz-$(date +%s)"
pnpm exec next analyze --output --snapshot "$SNAP"
pnpm exec next analyze export --snapshot "$SNAP" | gzip > .wimb/bundle-graph.jsonl.gz
\`\`\`

2. Build the route-rooted forest JSON with WIMB (Node ≥ 20):

\`\`\`bash
# From binary artifacts (works for both analyze and experimental-analyze)
npx --yes github:MaxwellCohen/where-is-my-banana#npx wimb viz build --cwd . -o .wimb/bundle-graph.json

# Or from a JSONL export if you created one above:
# npx --yes github:MaxwellCohen/where-is-my-banana#npx wimb viz build --analyze-export .wimb/bundle-graph.jsonl.gz -o .wimb/bundle-graph.json
\`\`\`

If \`viz\` is missing on that npx snapshot, clone https://github.com/MaxwellCohen/where-is-my-banana, run \`pnpm install && pnpm build\`, then:

\`\`\`bash
node /path/to/where-is-my-banana/packages/cli/dist/index.js viz build --cwd "$(pwd)" -o .wimb/bundle-graph.json
\`\`\`

Optional: add \`--async\` to include dynamic import edges.

3. Open the visualizer and open the graph **locally in the browser** (nothing is uploaded to the host):

- URL: ${url}
- Click **Open local file**
- Choose \`.wimb/bundle-graph.json\` from this project (parsed client-side only)

Privacy: do not POST the graph to any API, gist, or chat attachment unless the user explicitly asks. The hosted app has no server upload endpoint.

## Success criteria

- Hosted page starts blank until the local JSON is opened
- Visualizer shows this project's routes
- Client / Server filter and Sorted files view work
- Brief summary of the heaviest app files by "pulls in" weight on the default route
`;
}
