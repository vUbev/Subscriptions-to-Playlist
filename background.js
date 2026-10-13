// Clicking the toolbar button opens the settings page.
browser.browserAction.onClicked.addListener(() => browser.runtime.openOptionsPage());

// On first install (not on updates), take the user straight to the settings page.
browser.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") browser.runtime.openOptionsPage();
});
