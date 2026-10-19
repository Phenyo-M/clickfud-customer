// Back arrow on the standalone legal pages: back to the page you came from
// inside ClickFood, otherwise the ClickFood home page.
(function () {
  var a = document.querySelector('[data-legal-back]');
  if (!a) return;
  a.addEventListener('click', function (e) {
    var sameSite = document.referrer && document.referrer.indexOf(location.origin) === 0;
    if (sameSite && history.length > 1) { e.preventDefault(); history.back(); }
  });
})();
