// Applies the theme stored on this device before the app loads, so a dark preference never flashes
// light. Keep the storage key and values in sync with src/app/theme.ts.
(function () {
  try {
    var value = window.localStorage.getItem("officebox.theme");
    if (value === "light" || value === "dark") document.documentElement.setAttribute("data-theme", value);
  } catch {
    // Storage can be unavailable (private mode, blocked site data); the system theme applies.
  }
})();
