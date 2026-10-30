import { ErrorBoundary } from "@/components/ErrorBoundary";
import { VisualizerApp } from "@/components/VisualizerApp";

export default function HomePage() {
  return (
    <ErrorBoundary>
      <VisualizerApp />
    </ErrorBoundary>
  );
}
