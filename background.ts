import { getHyperTortureMode, resetHyperTortureStreak, storage } from "storage"

//Constants
const LEETCODE_URL = "https://leetcode.com"
const RULE_ID = 1

// Helper functions
const isLeetCodeUrl = (url: string) => url.includes(LEETCODE_URL)

const isSubmissionSuccessURL = (url: string) =>
  url.includes("/submissions/detail/") && url.includes("/check/")

const sendUserSolvedMessage = (languageUsed: string) => {
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    chrome.tabs.sendMessage(tabs[0].id, {
      action: "userSolvedProblem",
      language: languageUsed
    })
  })
}

const sendUserFailedMessage = () => {
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    chrome.tabs.sendMessage(tabs[0].id, {
      action: "userFailedProblem"
    })
  })
}
//Global modifiable variables (I know, I know, but it's the easiest way to do it fix it yourself)

let leetcodeProblemSolved = false
let leetCodeProblem = {
  url: "",
  name: ""
}
let lastSubmissionDate = new Date(0)
let solvedListenerActive = false
let lastAttemptedUrl = null
let urlListener = null

// Get Problem List from leetcode graphql API
const getProblemListFromLeetCodeAPI = async (difficulty, problemSet) => {
  try {
    const query = `
      query problemsetQuestionList {
        problemsetQuestionList: questionList(
          categorySlug: ""
          limit: -1
          skip: 0
          filters: {
            ${
              difficulty && difficulty !== "all"
                ? "difficulty: " + difficulty
                : ""
            }
            ${problemSet?.length ? "listId: " + '"' + problemSet + '"' : ""}
          }
        ) {
          questions: data {
            acRate
            difficulty
            freqBar
            frontendQuestionId: questionFrontendId
            isFavor
            paidOnly: isPaidOnly
            status
            title
            titleSlug
            topicTags {
              name
              id
              slug
            }
            hasSolution
            hasVideoSolution
          }
        }
      }
    `

    const body = {
      query
    }

    const response = await fetch("https://leetcode.com/graphql", {
      method: "POST",
      body: JSON.stringify(body),
      headers: {
        "Content-Type": "application/json"
      }
    })

    const responseData = await response.json()
    await storage.updatePermissions(true)
    return responseData.data.problemsetQuestionList.questions
  } catch (error) {
    console.log(error.toString())
    if (
      error.message.includes("NetworkError") ||
      error.message.includes("CORS") ||
      error.message === "Network response was not ok"
    ) {
      console.log("CORS error detected.")
      await storage.updatePermissions(false)
    }
    return undefined
  }
}

async function generateRandomLeetCodeProblem(): Promise<{
  url: string
  name: string
}> {
  try {
    const problemSet = await storage.getProblemSet()
    const difficulty = await storage.getDifficulty()
    const includePremium = await storage.getIncludePremium()
    let leetCodeProblems = []
    // Check if list is from Leetcode Graphql or all
    if (problemSet === "all" || problemSet.startsWith("lg")) {
      await storage.initiateLoading()
      // Remove lg- or all from string for better logic processing
      leetCodeProblems = await getProblemListFromLeetCodeAPI(
        difficulty,
        problemSet?.slice(3) || ""
      )
      let randomIndex = Math.floor(Math.random() * leetCodeProblems.length)
      while (leetCodeProblems[randomIndex].paidOnly) {
        randomIndex++
        randomIndex =
          (leetCodeProblems.length + randomIndex) % leetCodeProblems.length
      }
      const randomProblem = leetCodeProblems[randomIndex]
      // Replace anything that is not a string or whitespace with "" then replace empty spaces with "-"
      const randomProblemURL =
        "https://leetcode.com/problems/" +
        randomProblem.title
          .trim()
          .replace(/[^a-zA-Z\s]/g, "")
          .replace(/\s+/g, "-")
          .toLowerCase() +
        "/"
      const randomProblemName = randomProblem.title
      // await storage.set("loading", false)
      await storage.stopLoading()
      return { url: randomProblemURL, name: randomProblemName }
    } else {
      // TODO: Need to find a way to filter out premium problems for these JSON files
      const problemSetURLs = {
        allNeetcode: "leetcode-problems/allProblems.json",
        NeetCode150: "leetcode-problems/neetCode150Problems.json",
        Blind75: "leetcode-problems/blind75Problems.json"
      }
      const res = await fetch(chrome.runtime.getURL(problemSetURLs[problemSet]))
      leetCodeProblems = await res.json()
      leetCodeProblems = leetCodeProblems.filter((problem) => {
        return (
          (includePremium || !problem.isPremium) &&
          (difficulty == "all" ||
            problem.difficulty.toLowerCase() === difficulty.toLowerCase())
        )
      })

      let randomIndex = Math.floor(Math.random() * leetCodeProblems.length)
      const randomProblem = leetCodeProblems[randomIndex]
      const randomProblemURL = randomProblem.href
      const randomProblemName = randomProblem.text
      return { url: randomProblemURL, name: randomProblemName }
    }
  } catch (error) {
    console.error("Error generating random problem", error)
    return undefined
  } finally {
    await storage.stopLoading()
  }
}

// Communication functions between background.js, popup.js, and content.js
const onMessageReceived = (message, sender, sendResponse) => {
  switch (message.action) {
    case "fetchingProblem":
      // Handle the start of the problem fetch.
      // Currently, we'll just log it for clarity, but you can add other logic here if needed.
      console.log("Fetching problem started.")
      break
    case "problemFetched":
      // Handle the end of the problem fetch.
      console.log("Fetching problem completed.")
      break
    case "getProblemStatus":
      sendResponse({
        problemSolved: leetcodeProblemSolved,
        problem: leetCodeProblem
      })
      return true
    case "userClickedSubmit":
      lastSubmissionDate = new Date()
      solvedListenerActive = true
      console.log("User clicked submit, adding listener", solvedListenerActive)
      chrome.webRequest.onCompleted.addListener(checkIfUserSolvedProblem, {
        urls: ["*://leetcode.com/submissions/detail/*/check/"]
      })
      break
    default:
      console.warn("Unknown message action:", message.action)
  }
}

async function setRedirectRule(newRedirectUrl: string) {
  // Can't use built in chrome types for firefox
  let newRedirectRule = {
    id: RULE_ID,
    priority: 1,
    action: {
      type: "redirect",
      redirect: { url: newRedirectUrl }
    },
    condition: {
      urlFilter: "*://*/*",
      // Modify this if we want to exclude more specific domains (redirect won't apply to them)
      excludedInitiatorDomains: [
        "leetcode.com",
        "www.leetcode.com",
        "developer.chrome.com"
      ],

      resourceTypes: ["main_frame"]
    }
  }

  try {
    chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [RULE_ID],
      // Type error for addRules, but it works
      // @ts-ignore
      addRules: [newRedirectRule]
    })
    console.log("Redirect rule updated")
  } catch (error) {
    console.error("Error updating redirect rule:", error)
  }
}

export const updateStorage = async () => {
  try {
    var problem = await generateRandomLeetCodeProblem()
    console.log("Random problem generated: ", problem)
    leetcodeProblemSolved = false
    await Promise.all([
      storage.updateProblem(problem, leetcodeProblemSolved),
      setRedirectRule(problem.url)
    ])
  } catch (error) {
    throw new Error("Error generating random problem: " + error)
  }
}

const checkIfUserSolvedProblem = async (details) => {
  // If the user has already solved the problem, then don't do anything
  if (await storage.getProblemSolved()) return
  // Get the current active tab's URL
  let currentURL = ""
  try {
    const [activeTab] = await new Promise<chrome.tabs.Tab[]>((resolve) => {
      chrome.tabs.query({ active: true, currentWindow: true }, resolve)
    })

    currentURL = activeTab.url
  } catch (error) {
    console.error("Error getting active tab:", error)
    return
  }

  const problemUrl = await storage.getProblemUrl()

  const sameUrl =
    problemUrl === currentURL || problemUrl + "description/" === currentURL

  if (
    !sameUrl // Checking with the active tab's URL
  ) {
    return
  }

  //lastCheckedUrl = details.url
  //lastCheckedTimestamp = now

  if (solvedListenerActive) {
    // Remove the listener so that it doesn't fire again, since the outcome will either be success or fail
    // And we'll add it again when the user clicks submit
    solvedListenerActive = false
    chrome.webRequest.onCompleted.removeListener(checkIfUserSolvedProblem)
  }

  if (isSubmissionSuccessURL(details.url)) {
    try {
      const hyperTortureMode = await getHyperTortureMode()
      const response = await fetch(details.url)
      const data = await response.json()
      if (data.state === "STARTED" || data.state === "PENDING") {
        console.log("Submission is still in progress")
        // We're not done yet, so add the listener again
        if (!solvedListenerActive) {
          solvedListenerActive = true
          chrome.webRequest.onCompleted.addListener(checkIfUserSolvedProblem, {
            urls: ["*://leetcode.com/submissions/detail/*/check/"]
          })
        }
        return
      }
      console.log("Checking if state is success")
      if (data.status_msg !== "Accepted") {
        if (hyperTortureMode) {
          await resetHyperTortureStreak()
          sendUserFailedMessage()
        }
        console.log(
          "It is not a success submission, user did not solve problem"
        )
        return
      }
      if (
        data.status_msg === "Accepted" &&
        data.state === "SUCCESS" &&
        !data.code_answer
      ) {
        console.log("It is a success submission, user solved problem")
        await storage.updateStreak()

        leetcodeProblemSolved = true
        // They solved the problem, so no need to redirect anymore they're free, for now
        chrome.declarativeNetRequest.updateDynamicRules({
          removeRuleIds: [RULE_ID] // use RULE_ID constant
        })
        chrome.webRequest.onCompleted.removeListener(checkIfUserSolvedProblem)
        console.log("User solved problem, should've gotten the success message")
        if (hyperTortureMode) {
          if (lastAttemptedUrl) {
            chrome.tabs.update({ url: lastAttemptedUrl })
          }
          await updateStorage()
        } else {
          sendUserSolvedMessage(data?.lang)
        }
      }
    } catch (error) {
      console.error("Error:", error)
    }
  }
}

// Resets the completion streak when at least one day has passed since last completion
async function tryResetStreak() {
  const lastCompletion = await storage.getLastCompletion()
  const yesterday = new Date().getDate() - 1
  if (lastCompletion.getDate() < yesterday) {
    await storage.resetStreak()
    return true
  }
  return false
}

export async function toggleUrlListener(toggle: boolean): Promise<void> {
  if (toggle) {
    // Save users request url for further redirect
    urlListener = chrome.webRequest.onBeforeRequest.addListener(
      (details) => {
        if (
          !isLeetCodeUrl(details.url) &&
          details.type === "main_frame" &&
          !details.url.includes("chrome-extension:")
        ) {
          // Save the URL the user tried to open
          lastAttemptedUrl = details.url
          console.log(lastAttemptedUrl)
        }
      },
      { urls: ["<all_urls>"] }
    )
  } else {
    chrome.webRequest.onBeforeRequest.removeListener(urlListener)
  }
}

// Initialize
chrome.runtime.onInstalled.addListener(async () => {
  await updateStorage()
  await tryResetStreak()
  await toggleUrlListener(await getHyperTortureMode())
})

// Ensure the alarm is set when the extension starts
chrome.alarms.get("midnightAlarm", (alarm) => {
  if (!alarm) {
    // Find the time duration until midnight
    const currentTime = Date.now()
    const midnight = new Date()
    midnight.setHours(24, 0, 0, 0)
    const msUntilMidnight = midnight.getTime() - currentTime
    //Create an alarm to update the storage every 24 hours at midnight
    chrome.alarms.create("midnightAlarm", {
      // When means the time the alarm will fire, so in this case it will fire at midnight
      when: Date.now() + msUntilMidnight,
      // Period means the time between each alarm firing, so in this case it will fire every 24 hours after the first midnight alarm
      periodInMinutes: 24 * 60
    })
  }
})

// Update the storage and check if streak should be reset when the alarm is fired
chrome.alarms.onAlarm.addListener(async () => {
  await updateStorage()
  await tryResetStreak()
})
// Need to add these listeners to global scope so that when the workers become inactive, they are set again
chrome.runtime.onMessage.addListener(onMessageReceived)
