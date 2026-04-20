# Personal AI Assistant Chatbot

Build a sleek, AI-powered **Personal AI Assistant** chatbot with a modern web interface. The assistant can answer questions, help with writing, brainstorm ideas, explain concepts, and have general conversations.

## User Review Required

> [!IMPORTANT]
> **API Key Required**: This project uses the **Google Gemini API** (free tier available). You'll need to get an API key from [Google AI Studio](https://aistudio.google.com/apikey). The app will prompt you to enter it on first use.

> [!NOTE]
> If you'd prefer to use **OpenAI** or another provider instead of Gemini, let me know and I'll adjust the plan.

## Proposed Changes

### Architecture Overview

```
chatbot_test/
├── server/
│   ├── app.py              # Flask backend server
│   ├── requirements.txt     # Python dependencies
│   └── .env.example         # Environment variable template
├── static/
│   ├── index.html           # Main chat page
│   ├── css/
│   │   └── style.css        # All styling (dark theme, glassmorphism)
│   └── js/
│       └── app.js           # Chat logic, API calls, animations
└── README.md                # Updated project docs
```

---

### Backend — Python Flask + Gemini API

#### [NEW] server/app.py
- Flask server with a `/api/chat` POST endpoint
- Accepts user messages, forwards to Google Gemini API (`gemini-2.0-flash`)
- Maintains conversation history per session for contextual replies
- Streams responses back to the frontend for a real-time typing effect
- CORS enabled for local development

#### [NEW] server/requirements.txt
- `flask` — Web server
- `flask-cors` — Cross-origin support
- `google-generativeai` — Official Google Gemini SDK
- `python-dotenv` — Environment variable management

#### [NEW] server/.env.example
- Template with `GEMINI_API_KEY=your_key_here`

---

### Frontend — Modern Chat UI

#### [NEW] static/index.html
- Single-page chat interface
- API key input modal (shown on first use, stored in localStorage)
- Chat message area with auto-scroll
- Input bar with send button and keyboard shortcut (Enter to send)
- Responsive layout (mobile-friendly)

#### [NEW] static/css/style.css
Premium dark-theme design with:
- **Dark gradient background** with subtle animated gradient shifts
- **Glassmorphism** chat container (frosted glass effect with backdrop-filter)
- **Modern typography** using Google Font "Inter"
- **Smooth animations**: message fade-in, typing indicator pulse, send button hover effects
- **Custom scrollbar** styling
- **Message bubbles**: distinct colors for user (accent gradient) vs assistant (glass surface)
- **Responsive design**: works beautifully on desktop and mobile
- Color palette: Deep navy/charcoal background, electric blue/purple accent gradients

#### [NEW] static/js/app.js
- Sends messages to Flask backend via `fetch` with streaming (`ReadableStream`)
- Renders markdown in assistant responses (bold, code blocks, lists)
- Typing indicator animation while waiting for response
- Auto-scroll to latest message
- LocalStorage for API key persistence
- Keyboard shortcuts (Enter to send, Shift+Enter for newline)
- Chat history management (new chat button to clear)

---

### Documentation

#### [MODIFY] README.md
- Project description, setup instructions, screenshots reference

## Key Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| AI Provider | Google Gemini (gemini-2.0-flash) | Free tier, fast, high quality |
| Backend | Python Flask | Simple, widely known, quick to set up |
| Frontend | Vanilla HTML/CSS/JS | No build step, lightweight, easy to run |
| Styling | Dark glassmorphism theme | Modern, premium feel |
| API Key Storage | Browser localStorage | Simple for a test/personal project |
| Streaming | Server-Sent Events style | Real-time typing effect for responses |

## Verification Plan

### Automated Tests
- Start the Flask server and verify `/api/chat` responds correctly
- Open the frontend in the browser and verify the UI renders properly

### Manual Verification
- Send test messages and confirm AI responses stream in
- Test responsive layout at different viewport sizes
- Verify API key modal appears on first use
- Test keyboard shortcuts (Enter, Shift+Enter)
- Visual inspection of animations and glassmorphism effects
