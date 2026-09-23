export async function openBrowserTranscriptPanel() {
  const window=await chrome.windows.getCurrent();
  await chrome.sidePanel.setOptions({path:'browser-transcript.html',enabled:true});
  await chrome.sidePanel.open({windowId:window.id});
}
