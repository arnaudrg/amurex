const AMUREX_CONFIG = {
  BASE_URL_BACKEND: "http://localhost:8080",  // Your backend server URL
  BASE_URL_WEB: "http://localhost:8080",      // Your web server URL
  ANALYTICS_ENABLED: true                     // Set to false to disable tracking
};

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error(error));

// Check whether new version is installed
chrome.runtime.onInstalled.addListener(function (details) {
  if (details.reason == "install") {
    // Open welcome page in new tab
    chrome.tabs.create({
      url: AMUREX_CONFIG.BASE_URL_WEB + "/signup?welcome=true",
    });
  } else if (details.reason == "update") {
    let thisVersion = chrome.runtime.getManifest().version;
    console.log(
      "Updated from " + details.previousVersion + " to " + thisVersion + "!"
    );
  }
});

// function deleteKeysFromStorage() {
//   const keysToDelete = ['mId'];

//   chrome.storage.local.remove(keysToDelete, function() {
//       if (chrome.runtime.lastError) {
//           console.error("Error deleting keys:", chrome.runtime.lastError);
//       } else {
//           console.log(`Keys deleted: ${keysToDelete.join(', ')}`);
//       }
//   });
// }

async function getUserId() {
  session = await chrome.cookies.get({
    url: AMUREX_CONFIG.BASE_URL_WEB,
    name: "amurex_session",
  });
  if (session && session.value) {
    const decodedSession = JSON.parse(decodeURIComponent(session.value));
    const userId = decodedSession.user.id;
    return userId;
  }
  return null;
}

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (message.type == "new_meeting_started") {
    // Saving current tab id, to download transcript when this tab is closed
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      const tabId = tabs[0].id;
      chrome.storage.local.set({ meetingTabId: tabId }, function () {
        console.log("Meeting tab id saved");
      });
    });
  } else if (message.type == "download") {
    // Invalidate tab id since transcript is downloaded, prevents double downloading of transcript from tab closed event listener
    downloadTranscript();
  } else if (message.action === "getUserId") {
    (async () => {
      const userId = await getUserId();
      sendResponse({ userId });
    })();
    return true;
  } else if (message.action === "checkAuthentication") {
    // Check cookies sequentially
    // const checkCookies = async () => {
    // Make the message handler async
    (async () => {
      for (const cookieInfo of message.cookies) {
        const cookie = await chrome.cookies.get({
          url: cookieInfo.url,
          name: cookieInfo.name,
        });

        if (cookie && cookie.value) {
          sendResponse({ is_authenticated: true });
          return;
        }
      }
      sendResponse({ is_authenticated: false });
    })();

    return true;
    // };
  } else if ( message.type === "meeting_ended") {
    chrome.storage.local.set({ hasMeetingEnded: true }, function () {
      console.log("Meeting ended flag set");
    });
    // deleteKeysFromStorage();
  } 
    else if (
    message.type === "open_side_panel" ||
    message.type === "open_late_meeting_side_panel" ||
    message.type === "open_file_upload_panel"
  ) {
    const pathMap = {
      open_side_panel: "sidepanels/sidepanel.html",
      open_late_meeting_side_panel: `sidepanels/lateMeetingSidePanel.html${
        message.meetingId ? `?meetingId=${message.meetingId}` : ""
      }`,
      open_file_upload_panel: `sidepanels/file_upload_panel.html${
        message.meetingId ? `?meetingId=${message.meetingId}` : ""
      }`,
    };

    const panelPath = pathMap[message.type];

    // Set options first
    chrome.sidePanel.setOptions({
      tabId: sender.tab.id,
      path: panelPath,
      enabled: true,
    });

    // Open the panel
    chrome.sidePanel.open({ tabId: sender.tab.id });

    // Set storage values
    chrome.storage.local.set({ redirect: message.type });
    
    if (message.meetingId) {
      chrome.storage.local.set({ meetingId: message.meetingId });
    }

    // Set the navigation item
    let navItem;
    if (message.type === "open_late_meeting_side_panel") {
      navItem = "lateMeetingSidePanel";
    } else if (message.type === "open_file_upload_panel") {
      navItem = "file_upload_panel";
    } else if (message.type === "open_side_panel") {
      // Make tracking request with valid userId
      (async () => {
        const userId = await getUserId();
        if (userId) {
          fetch(`${AMUREX_CONFIG.BASE_URL_BACKEND}/track`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json",
            },
            body: JSON.stringify({ 
              uuid: userId,
              event_type: "open_sidepanel",
              meeting_id: "unknown"
            }),
          }).catch(error => {
            console.error("Error tracking sidepanel open:", error);
          });
        }
      })();
      navItem = "sidepanel";
    } else {
      console.error("Invalid side panel type");
    }

    chrome.storage.local.set({ navItem });
  }
});


// Download transcript if meeting tab is closed
chrome.tabs.onRemoved.addListener(async function (tabid) {
  const data = await chrome.storage.local.get(["meetingTabId", "hasMeetingEnded"]);
  
  if (tabid == data.meetingTabId) {
    console.log("Successfully intercepted tab close");
    
    // Check if it was a meeting page using storage flag
    if (data.hasMeetingEnded) {
      console.log("Meeting ended, skipping notification");
      await chrome.storage.local.set({ 
        meetingTabId: null,
        hasMeetingEnded: false 
      });
      console.log("Meeting tab id cleared for next meeting");
      return;
    }
    
    // Create new tab and wait for it
    const newTab = await chrome.tabs.create({ 
      url: "https://meet.google.com/landing" 
    });

    // Wait a bit for the page to start loading
    await new Promise(resolve => setTimeout(resolve, 500));

    // Execute script in the new tab
    try {
      await chrome.scripting.executeScript({
        target: { tabId: newTab.id },
        function: injectNotification,
      });
      console.log("Notification injection script executed");
    } catch (error) {
      console.error("Error injecting notification:", error);
    }

    // Clear meetingTabId and hasMeetingEnded flags
    await chrome.storage.local.set({ 
      meetingTabId: null,
      hasMeetingEnded: false, 
    });
    console.log("Meeting tab id cleared for next meeting");

    // deleteKeysFromStorage();
  }
});

// Function to inject notification into the page
async function injectNotification() {
  // Wait for the document body to be available
  if (!document.body) {
    await new Promise(resolve => {
      const observer = new MutationObserver((mutations, obs) => {
        if (document.body) {
          obs.disconnect();
          resolve();
        }
      });
      
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true
      });
    });
  }

  console.log("Injecting notification");
  let html = document.querySelector("html");
  let obj = document.createElement("div");
  obj.id = "live-notification";
  let logo = document.createElement("img");
  let text = document.createElement("p");
  let buttonContainer = document.createElement("div");

  // Style the container
  obj.style.cssText = `
    position: fixed;
    top: 20px;
    right: 50%;
    transform: translateX(50%);
    background: black;
    padding: 20px;
    border-radius: 8px;
    z-index: 10000;
    width: 400px;
    font-family: "Host Grotesk", sans-serif;
  `;

  // Style logo
  logo.setAttribute(
    "src",
    "https://www.amurex.ai/_next/image?url=%2F_next%2Fstatic%2Fmedia%2FAmurexLogo.56901b87.png&w=64&q=75"
  );
  logo.setAttribute("height", "32px");
  logo.setAttribute("width", "32px");
  logo.style.cssText = "border-radius: 4px";

  // Style text
  text.style.cssText = `
    color: #fff;
    margin: 10px 0;
  `;
  text.innerHTML = "Meeting ended. Would you like to see the summary and action items?";

  // Style button container
  buttonContainer.style.cssText = "display: flex; gap: 10px; margin-top: 10px;";

  // Create Yes button
  let yesButton = document.createElement("button");
  yesButton.textContent = "Yes";
  yesButton.style.cssText = `
    background: rgb(209, 173, 211);
    color: white;
    border: none;
    padding: 5px 15px;
    border-radius: 4px;
    cursor: pointer;
    font-family: "Host Grotesk", sans-serif;
    font-weight: 500;
  `;

  // Create No button
  let noButton = document.createElement("button");
  noButton.id = "no-button";
  noButton.textContent = "No";
  noButton.style.cssText = `
    background: transparent;
    color: rgb(209, 173, 211);
    border: 1px solid rgb(209, 173, 211);
    padding: 5px 15px;
    border-radius: 4px;
    cursor: pointer;
    font-family: "Host Grotesk", sans-serif;
    font-weight: 500;
  `;

  // Add click handlers
  yesButton.addEventListener("click", () => {
    console.log("Yes button clicked");
    chrome.runtime.sendMessage({ type: "open_side_panel" });
    obj.remove();
  });

  noButton.addEventListener("click", () => {
    obj.remove();
  });

  // Assemble the components
  obj.appendChild(logo);
  obj.appendChild(text);
  obj.appendChild(buttonContainer);
  buttonContainer.appendChild(yesButton);
  buttonContainer.appendChild(noButton);

  if (html) html.append(obj);

  // Auto-hide after 4 seconds
  setTimeout(() => {
    if (obj && obj.parentNode) {
      obj.remove();
    }
  }, 4000);
}

function downloadTranscript() {
  chrome.storage.local.get(
    [
      "userName",
      "transcript",
      "chatMessages",
      "meetingTitle",
      "meetingStartTimeStamp",
    ],
    function (result) {
      if (result.userName && result.transcript && result.chatMessages) {
        // Create file name if values or provided, use default otherwise
        const fileName =
          result.meetingTitle && result.meetingStartTimeStamp
            ? `Amurex/Transcript-${result.meetingTitle} at ${result.meetingStartTimeStamp}.txt`
            : `Amurex/Transcript.txt`;

        const transcriptString = JSON.stringify(result.transcript, null, 2);
        console.log(`THIS IS THE TRANSCRIPT BEFORE SAVING TO TXT: ${transcriptString}`);
        
            // Create an array to store lines of the text file
        const lines = [];

        // Iterate through the transcript array and format each entry
        result.transcript.forEach((entry) => {
          lines.push(`${entry.personName} (${entry.timeStamp})`);
          lines.push(entry.personTranscript);
          // Add an empty line between entries
          lines.push("");
        });
        lines.push("");
        lines.push("");

        if (result.chatMessages.length > 0) {
          // Iterate through the chat messages array and format each entry
          lines.push("---------------");
          lines.push("CHAT MESSAGES");
          lines.push("---------------");
          result.chatMessages.forEach((entry) => {
            lines.push(`${entry.personName} (${entry.timeStamp})`);
            lines.push(entry.chatMessageText);
            // Add an empty line between entries
            lines.push("");
          });
          lines.push("");
          lines.push("");
        }

        // Join the lines into a single string, replace "You" with userName from storage
        const textContent = lines
          .join("\n")
          .replace(/You \(/g, result.userName + " (");

        console.log(textContent);

        // Create a blob containing the text content
        const blob = new Blob([textContent], { type: "text/plain" });

        // Read the blob as a data URL
        const reader = new FileReader();

        // Download once blob is read
        reader.onload = function (event) {
          const dataUrl = event.target.result;

          // Create a download with Chrome Download API
          chrome.downloads
            .download({
              url: dataUrl,
              filename: fileName,
              conflictAction: "uniquify",
            })
            .then(() => {
              console.log("Transcript downloaded to Amurex directory");
            })
            .catch((error) => {
              console.log(error);
              chrome.downloads.download({
                url: dataUrl,
                filename: "Amurex/Transcript.txt",
                conflictAction: "uniquify",
              });
              console.log(
                "Invalid file name. Transcript downloaded to Amurex directory with simple file name."
              );
            });
        };

        // Read the blob and download as text file
        reader.readAsDataURL(blob);
      } else console.log("No transcript found");
    }
  );
}

chrome.action.onClicked.addListener(async (tab) => {
  await chrome.sidePanel.setOptions({
    enabled: true,
    path: "sidepanels/sidepanel.html",
  });
  chrome.sidePanel.open({ tabId: tab.id });
});

