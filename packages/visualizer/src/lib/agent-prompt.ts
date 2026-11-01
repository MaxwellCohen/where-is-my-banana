/** Agent prompt that captures a Next.js analyze graph and loads it into this visualizer. */
export function buildAgentPrompt(visualizerUrl: string): string {
  const url = visualizerUrl.replace(/\/$/, "");
  return `Reduce this project's first-load client JS (Next.js 16+ or Vite). Do not upgrade \`next\`.

1. From the project root (Node >= 20), measure and rank the wins. It auto-detects Next/Vite and writes \`.wimb/\` (add it to .gitignore):

\`\`\`bash
npx --yes @maxwellcohen/wimb wins
\`\`\`

2. Apply the top safe win in \`.wimb/wins.json\`, re-run the command, and keep the edit only if the bytes drop. Repeat.

3. Open the visualizer pre-loaded with the results (no file picking). It opens ${url} in the user's browser with the graph and wins embedded in the link:

\`\`\`bash
npx --yes @maxwellcohen/wimb open
\`\`\`

For large graphs this serves the data from localhost until the page loads it (up to 2 minutes), so run it in the background and don't wait on it. If no browser opens, add \`--no-launch\` and give the user the printed URL.

Finish with the before/after first-load size and the edits made.
`;
}
