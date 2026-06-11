# branch-exclusive-eager-import

## When it fires

A component is statically imported but only rendered in one branch of an `if/else` or ternary. The other branch never needs that module, so it should be code-split with `next/dynamic`.

Common cases:

- Route shells: `if (isHomePage) <HomeContent /> else <DocsLayout />`
- Feature toggles: `showEditor ? <Editor /> : <Viewer />`

## Steps

1. Remove the static import for the branch-exclusive component
2. Add `import dynamic from 'next/dynamic'`
3. Replace with `const Component = dynamic(() => import('./Component'), { loading: () => <Fallback /> })`
4. Keep the existing conditional JSX unchanged
5. Re-run `wimb scan`

## Example

```tsx
import dynamic from "next/dynamic";

const HomeContent = dynamic(() => import("./HomeContent"), {
  loading: () => null,
});

let content;
if (isHomePage) {
  content = <HomeContent />;
} else {
  content = <div>...</div>;
}
```
