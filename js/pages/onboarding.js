/* ============================================================
   CLICKFUD — first-time welcome/onboarding screen ("Page 0").

   Shown exactly once, before anything else in the app (even the
   auth-check splash) — gated purely by a localStorage flag, entirely
   independent of login state. Pressing Next marks it complete and
   hands off to whatever the existing app would normally show next
   (the public home page for a guest, or straight into a dashboard if
   a session already existed) — this file never decides that, it only
   marks itself done and lets js/app.js's existing routing take over.
   No login/signup/cart/nav/chatbot on this screen by design.
   ============================================================ */
window.App = window.App || {};
App.Pages = App.Pages || {};

App.Pages.Onboarding = (function () {
  function render() {
    return `
    <div class="onboarding-screen">
      <div class="onboarding-media">
        <div class="onboarding-media-badge"><img src="icons/clickfud-icon-192.png" alt="" /></div>
      </div>

      <div class="onboarding-content">
        <p class="onboarding-eyebrow">Campus food. Made easy.</p>
        <h1 class="onboarding-headline">Your Campus.<br>Your Food.<br><span class="onboarding-highlight">Your Click.</span></h1>
        <p class="onboarding-sub">Order from your favourite food shops, skip the queue, and collect your meal when it’s ready.</p>

        <div class="onboarding-benefits">
          <div class="onboarding-benefit">
            <div class="onboarding-benefit-icon"><i data-lucide="utensils"></i></div>
            <span>Food Ordering</span>
          </div>
          <div class="onboarding-benefit">
            <div class="onboarding-benefit-icon"><i data-lucide="shopping-bag"></i></div>
            <span>Quick Collection</span>
          </div>
        </div>
      </div>

      <div class="onboarding-bottom">
        <button type="button" class="btn btn-primary btn-lg btn-block onboarding-next-btn" data-action="onboarding-next">
          Next <i data-lucide="arrow-right"></i>
        </button>
      </div>
    </div>`;
  }

  return { render };
})();
