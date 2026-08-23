// FIXTURE, deliberately bad. See scripts/check-ui-antipatterns.mjs selfCheck().
export function BounceEasingFixture() {
  return (
    <div className="transition-transform duration-300 ease-[cubic-bezier(0.68,-0.55,0.27,1.55)]">
      <p>Pop</p>
    </div>
  );
}
