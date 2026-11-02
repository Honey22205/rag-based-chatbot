const state = {
  documentId: null,
  busy: false,
};

const elements = {
  input: document.querySelector("#pdf-input"),
  dropZone: document.querySelector("#drop-zone"),
  uploadPanel: document.querySelector("#upload-panel"),
  pipelineHint: document.querySelector("#pipeline-hint"),
  pipelineSection: document.querySelector("#pipeline-section"),
  chatSection: document.querySelector("#chat-section"),
  documentOverview: document.querySelector("#document-overview"),
  overviewName: document.querySelector("#overview-name"),
  pageCount: document.querySelector("#page-count"),
  chunkCount: document.querySelector("#chunk-count"),
  overviewSize: document.querySelector("#overview-size"),
  processingPanel: document.querySelector("#processing-panel"),
  processingTitle: document.querySelector("#processing-title"),
  processingMessage: document.querySelector("#processing-message"),
  processingPercent: document.querySelector("#processing-percent"),
  progressFill: document.querySelector("#progress-fill"),
  questionInput: document.querySelector("#question-input"),
  chatForm: document.querySelector("#chat-form"),
  sendButton: document.querySelector("#send-button"),
  welcomeCard: document.querySelector("#welcome-card"),
  messages: document.querySelector("#messages"),
  chatArea: document.querySelector("#chat-area"),
  clearChat: document.querySelector("#clear-chat"),
  replaceFile: document.querySelector("#replace-file"),
  toast: document.querySelector("#toast"),
};

function formatBytes(bytes) {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function setStep(step, status) {
  const card = document.querySelector(`[data-step="${step}"]`);
  if (!card) return;
  card.classList.toggle("active", status === "active");
  card.classList.toggle("done", status === "done");
  const label = card.querySelector(".step-state");
  label.textContent = status === "active" ? "In progress" : status === "done" ? "Complete" : "Waiting";
}

function resetPipeline() {
  for (const step of ["read", "split", "embed", "retrieve", "answer"]) {
    setStep(step, "waiting");
  }
}

function setProgress(completed, total) {
  const percent = total ? Math.round((completed / total) * 100) : 0;
  elements.progressFill.style.width = `${percent}%`;
  elements.processingPercent.textContent = `${percent}%`;
  elements.processingMessage.textContent = `Embedding chunks · ${completed.toLocaleString()} of ${total.toLocaleString()}`;
}

function showError(message) {
  let friendlyMessage = message;
  if (/failed to allocate|out of memory|memory/i.test(message)) {
    friendlyMessage = "Ollama ran out of available memory. Close other apps or restart your computer, then try again.";
  }
  elements.toast.textContent = friendlyMessage;
  elements.toast.classList.remove("hidden");
  window.clearTimeout(showError.timeoutId);
  showError.timeoutId = window.setTimeout(() => elements.toast.classList.add("hidden"), 7000);
}

async function consumeEventStream(response, onEvent) {
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.detail || `The server returned ${response.status}.`);
  }
  if (!response.body) throw new Error("This browser does not support streamed responses.");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  function dispatch(record) {
    let eventName = "message";
    const data = [];
    for (const line of record.split(/\r?\n/)) {
      if (line.startsWith("event:")) eventName = line.slice(6).trim();
      if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    if (!data.length) return;
    const eventData = JSON.parse(data.join("\n"));
    if (eventName === "error") throw new Error(eventData.message || "The request failed.");
    onEvent(eventName, eventData);
  }

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const records = buffer.split(/\r?\n\r?\n/);
    buffer = records.pop() || "";
    for (const record of records) dispatch(record);
    if (done) break;
  }
  if (buffer.trim()) dispatch(buffer);
}

async function processPdf(file) {
  if (!file) return;
  if (!file.name.toLowerCase().endsWith(".pdf")) {
    showError("Please choose a PDF file.");
    return;
  }
  if (file.size > 50 * 1024 * 1024) {
    showError("This PDF is larger than 50 MB. Choose a smaller file.");
    return;
  }

  state.documentId = null;
  elements.messages.replaceChildren();
  elements.welcomeCard.classList.remove("hidden");
  elements.clearChat.classList.add("hidden");
  elements.uploadPanel.classList.remove("hidden");
  elements.chatSection.classList.add("hidden");
  elements.questionInput.disabled = true;
  elements.sendButton.disabled = true;
  elements.dropZone.classList.add("uploading");
  elements.pipelineSection.classList.remove("hidden");
  elements.documentOverview.classList.add("hidden");
  elements.processingPanel.classList.remove("hidden");
  elements.processingTitle.textContent = "Preparing your PDF";
  elements.processingMessage.textContent = "Starting document processing...";
  elements.processingPercent.textContent = "";
  elements.progressFill.style.width = "4%";
  elements.pipelineHint.textContent = "Reading your PDF...";
  resetPipeline();
  setStep("read", "active");

  const formData = new FormData();
  formData.append("file", file);

  try {
    await consumeEventStream(
      await fetch("/api/documents", { method: "POST", body: formData }),
      (event, data) => {
        if (event === "stage") {
          elements.processingMessage.textContent = data.message;
          if (/Extracted/.test(data.message)) {
            setStep("read", "done");
            setStep("split", "active");
            elements.pipelineHint.textContent = "Extracting and splitting text...";
          } else if (/Created/.test(data.message)) {
            setStep("read", "done");
            setStep("split", "done");
            setStep("embed", "active");
            elements.processingTitle.textContent = "Building your search index";
            elements.pipelineHint.textContent = "Making your document searchable...";
          }
        } else if (event === "progress") {
          setStep("read", "done");
          setStep("split", "done");
          setStep("embed", "active");
          setProgress(data.completed, data.total);
        } else if (event === "complete") {
          state.documentId = data.document_id;
          setStep("read", "done");
          setStep("split", "done");
          setStep("embed", "done");
          elements.progressFill.style.width = "100%";
          elements.processingPercent.textContent = "Ready";
          elements.processingTitle.textContent = "Your document is ready";
          elements.processingMessage.textContent = `${data.pages.toLocaleString()} pages · ${data.chunks.toLocaleString()} searchable chunks`;
          elements.uploadPanel.classList.add("hidden");
          elements.chatSection.classList.remove("hidden");
          elements.documentOverview.classList.remove("hidden");
          elements.overviewName.textContent = data.name;
          elements.pageCount.textContent = data.pages.toLocaleString();
          elements.chunkCount.textContent = data.chunks.toLocaleString();
          elements.overviewSize.textContent = formatBytes(data.size);
          elements.pipelineHint.textContent = "Ready for your questions";
          elements.questionInput.disabled = false;
          elements.questionInput.placeholder = "Ask anything about this document...";
          elements.questionInput.focus();
          for (const suggestion of document.querySelectorAll(".suggestion")) {
            suggestion.disabled = false;
          }
          window.setTimeout(() => elements.processingPanel.classList.add("hidden"), 1600);
        }
      },
    );
  } catch (error) {
    elements.processingTitle.textContent = "We couldn't process this PDF";
    elements.processingMessage.textContent = error.message;
    elements.processingPercent.textContent = "";
    elements.progressFill.style.width = "0%";
    showError(error.message);
  } finally {
    elements.dropZone.classList.remove("uploading");
  }
}

function addMessage(role, content = "") {
  const message = document.createElement("article");
  message.className = `message ${role}`;
  const avatar = document.createElement("span");
  avatar.className = "message-avatar";
  avatar.textContent = role === "assistant" ? "✦" : "Y";
  const body = document.createElement("div");
  body.className = "message-body";
  const author = document.createElement("div");
  author.className = "message-author";
  const authorName = document.createElement("span");
  authorName.textContent = role === "assistant" ? "RAG Studio" : "You";
  const timestamp = document.createElement("time");
  timestamp.textContent = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date());
  author.append(authorName, timestamp);
  const text = document.createElement("div");
  text.className = "message-text";
  text.textContent = content;
  body.append(author, text);
  message.append(avatar, body);
  elements.messages.append(message);
  elements.welcomeCard.classList.add("hidden");
  elements.clearChat.classList.remove("hidden");
  elements.chatArea.scrollTop = elements.chatArea.scrollHeight;
  return { message, text, body };
}

function showSources(body, sources) {
  if (!sources.length) return;
  const details = document.createElement("details");
  details.className = "sources";
  const summary = document.createElement("summary");
  summary.textContent = `${sources.length} source passage${sources.length === 1 ? "" : "s"} · from your PDF`;
  details.append(summary);
  for (const source of sources) {
    const item = document.createElement("div");
    item.className = "source-item";
    const page = document.createElement("span");
    page.className = "source-page";
    page.textContent = source.page === null ? "Page unavailable" : `Page ${source.page}`;
    const content = document.createElement("div");
    content.textContent = source.text;
    item.append(page, content);
    details.append(item);
  }
  body.append(details);
}

async function askQuestion(question) {
  if (!question.trim() || !state.documentId || state.busy) return;
  state.busy = true;
  elements.questionInput.value = "";
  elements.questionInput.disabled = true;
  elements.sendButton.disabled = true;
  addMessage("user", question.trim());
  const assistantMessage = addMessage("assistant");
  const cursor = document.createElement("span");
  cursor.className = "message-cursor";
  assistantMessage.text.append(cursor);
  const sources = [];
  setStep("retrieve", "active");
  setStep("answer", "waiting");
  elements.pipelineHint.textContent = "Finding relevant passages...";

  try {
    await consumeEventStream(
      await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ document_id: state.documentId, question }),
      }),
      (event, data) => {
        if (event === "sources") {
          sources.push(...data.sources);
          setStep("retrieve", "done");
          setStep("answer", "active");
          elements.pipelineHint.textContent = "Writing your answer...";
        } else if (event === "token") {
          cursor.before(document.createTextNode(data.text));
          elements.chatArea.scrollTop = elements.chatArea.scrollHeight;
        } else if (event === "complete") {
          cursor.remove();
          showSources(assistantMessage.body, sources);
          setStep("retrieve", "done");
          setStep("answer", "done");
          elements.pipelineHint.textContent = "Answer complete";
        }
      },
    );
  } catch (error) {
    cursor.remove();
    assistantMessage.text.textContent = error.message;
    assistantMessage.text.classList.add("error-text");
    showError(error.message);
    setStep("answer", "waiting");
    elements.pipelineHint.textContent = "Something interrupted the answer";
  } finally {
    state.busy = false;
    elements.questionInput.disabled = !state.documentId;
    elements.sendButton.disabled = !state.documentId;
    elements.questionInput.focus();
  }
}

elements.input.addEventListener("change", (event) => {
  processPdf(event.target.files[0]);
  event.target.value = "";
});

for (const eventName of ["dragenter", "dragover"]) {
  elements.dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    elements.dropZone.classList.add("dragging");
  });
}
for (const eventName of ["dragleave", "drop"]) {
  elements.dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    elements.dropZone.classList.remove("dragging");
  });
}
elements.dropZone.addEventListener("drop", (event) => processPdf(event.dataTransfer.files[0]));

elements.chatForm.addEventListener("submit", (event) => {
  event.preventDefault();
  askQuestion(elements.questionInput.value);
});
elements.questionInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    elements.chatForm.requestSubmit();
  }
});
elements.questionInput.addEventListener("input", () => {
  elements.questionInput.style.height = "auto";
  elements.questionInput.style.height = `${Math.min(elements.questionInput.scrollHeight, 110)}px`;
});

for (const suggestion of document.querySelectorAll(".suggestion")) {
  suggestion.disabled = true;
  suggestion.addEventListener("click", () => askQuestion(suggestion.dataset.question));
}

elements.clearChat.addEventListener("click", () => {
  elements.messages.replaceChildren();
  elements.welcomeCard.classList.remove("hidden");
  elements.clearChat.classList.add("hidden");
  setStep("retrieve", "waiting");
  setStep("answer", "waiting");
  elements.pipelineHint.textContent = "Ready when you are";
});
elements.replaceFile.addEventListener("click", () => elements.input.click());
