# 🎙️ Realtime Voice Assistant
**Angular + Spring Boot + OpenAI Realtime API**

A local demo application that provides:

- ✅ Live microphone transcription (Whisper)
- ✅ Real-time assistant text responses
- ✅ Angular frontend UI
- ✅ Spring Boot backend for secure token generation
- ✅ No API keys exposed to the browser

---

## 📌 Project Structure

realtime-backend/
│
├── realtime-backend/ # Spring Boot backend
│ └── src/main/java/... # Token + session API
│
├── realtime-ui/ # Angular frontend UI
│ └── src/app/... # WebRTC + Transcript UI
│
└── README.md
---

## ⚙️ Architecture Overview
Angular UI (localhost:4200)
↓
Spring Boot Backend (localhost:8080)
↓ (creates ephemeral client_secret)
OpenAI Realtime API (WebRTC streaming)

✔️ OpenAI API key stays **server-side only**  
✔️ Browser receives only short-lived ephemeral tokens

---

## ✅ Requirements

Make sure you have:

- Java 17+ (recommended: Java 21)
- Node.js LTS (v20+)
- Git
- OpenAI API Key with Realtime access

---

## 🔑 Environment Variable Setup

### ⚠️ Never hardcode your API key in code.

Set it as an environment variable:

### Windows PowerShell

``$env:OPENAI_API_KEY="sk-proj-xxxxxxxxxxxxxxxx"``

---

## ▶️ Run Backend (Spring Boot)

From repo root:
- cd realtime-backend
- ./gradlew bootRun

Backend runs at: `http://localhost:8080`

Test token endpoint: `http://localhost:8080/api/realtime-token`

---

## ▶️ Run Frontend (Angular)

From repo root:
- cd realtime-ui
- npm install
- npm start

Frontend runs at: `http://localhost:4200`

---

## 🎤 How to Use

Start Spring Boot backend

Start Angular frontend

Open UI in browser

Select microphone or Line-In device

Click Start

Speak → pause → transcript appears → assistant responds

---

## 🧠 Prompt / Context Customization

System context lives in:
`realtime-ui/src/app/prompt.ts`
