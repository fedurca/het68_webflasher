/** Tiny sync boot for <head> — prefer cookie so theme survives subdomain hops. */
(function () {
  try {
    var COOKIE = "het68_theme";
    var m = document.cookie.match(new RegExp("(?:^|; )" + COOKIE + "=([^;]*)"));
    var t = m ? decodeURIComponent(m[1]) : null;
    if (t !== "light" && t !== "dark") {
      try {
        t = localStorage.getItem("het68-theme");
      } catch (e) {
        t = null;
      }
    }
    if (t !== "light" && t !== "dark") {
      t =
        window.matchMedia && matchMedia("(prefers-color-scheme: light)").matches
          ? "light"
          : "dark";
    }
    document.documentElement.dataset.theme = t;
    document.documentElement.classList.toggle("theme-light", t === "light");
  } catch (e) {}
})();
