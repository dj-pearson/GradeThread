// FIXTURE, deliberately bad. See scripts/check-ui-antipatterns.mjs selfCheck().
export function GradientTextFixture() {
  return (
    <h1 className="bg-gradient-to-r from-purple-500 to-blue-500 bg-clip-text text-transparent">
      Grade with confidence
    </h1>
  );
}
