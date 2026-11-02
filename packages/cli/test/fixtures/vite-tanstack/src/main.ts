import { shared } from "./shared";
console.log(shared);
// Mirrors TanStack Start's code-split route components: lazily imported `?tsr-split=component` chunks.
console.log([
  () => import("./routes/index?tsr-split=component"),
  () => import("./routes/about?tsr-split=component"),
  () => import("./routes/example.chat?tsr-split=component"),
]);
