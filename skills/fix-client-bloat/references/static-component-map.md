# static-component-map

## When it fires

A module exports a large object that maps keys to components (MDX providers, Storybook registries, custom component maps). Every entry is statically imported, so any consumer of the map eagerly loads all referenced component subtrees.

Common cases:

- `MDXComponents` / `MDXProvider` component maps
- Global UI registries imported from app layout
- Storybook `parameters` or decorator component maps

## Steps

1. Identify which pages or routes actually need which map entries
2. Split one global map into smaller per-feature or per-route maps
3. Replace static imports with `dynamic(() => import('./Component'))` per heavy entry
4. Pass only the components a page needs instead of importing the full registry
5. Re-run `wimb scan`

## Example

```tsx
import dynamic from "next/dynamic";

const Sandpack = dynamic(() => import("./Sandpack"));
const CodeBlock = dynamic(() => import("./CodeBlock"));

export const MDXComponents = {
  pre: CodeBlock,
  Sandpack,
  // keep lightweight inline wrappers as-is
  p: (props) => <p {...props} />,
};
```

For MDX, consider separate maps per content section (blog vs reference docs) so doc pages do not ship interactive sandpack code.
