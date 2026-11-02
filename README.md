# RAG Document Chatbot

A local PDF question-answering app with a standalone HTML/CSS/JavaScript frontend and a Python FastAPI backend. Upload a PDF, watch extraction, chunking, and embedding progress, then ask questions and receive streamed answers with source pages.

## Architecture

```text
Browser UI (frontend/)
        │  HTTP + Server-Sent Events
        ▼
FastAPI (app.py) ── RAG pipeline (rag.py)
        │                  │
        │                  ├── PyPDF text extraction
        │                  ├── LangChain chunking
        │                  └── Chroma vector search
        ▼
Ollama: nomic-embed-text + gemma2:2b
```

The frontend is served by FastAPI from the same origin. PDF processing progress and generated answer tokens stream to the browser as Server-Sent Events. Documents and models run locally.

## Requirements

- Python 3.10 or later
- Ollama installed and running
- `nomic-embed-text` and `gemma2:2b` downloaded in Ollama

Download the models:

```powershell
ollama pull nomic-embed-text
ollama pull gemma2:2b
```

## Setup on Windows

From the project directory:

```powershell
python -m venv venv
.\venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
```

If PowerShell blocks environment activation, you can skip activation and run the virtual environment's Python directly.

## Run the app

From the project directory:

```powershell
.\venv\Scripts\python.exe -m uvicorn app:app --reload --host 127.0.0.1 --port 8000
```

Open [http://localhost:8000](http://localhost:8000) in your browser. Keep the terminal and Ollama running while you use the app.

## Project structure

```text
RAG-Document-Chatbot/
├── app.py                 # FastAPI API and frontend server
├── rag.py                 # PDF, chunking, vector search, and Ollama pipeline
├── frontend/
│   ├── index.html         # Browser UI
│   ├── styles.css         # Responsive visual design and animations
│   └── app.js             # Upload, progress, chat, and SSE client
├── requirements.txt
└── test_rag.py
```

## Notes

- PDF uploads are limited to 50 MB.
- Each upload gets its own vector index, so searches cannot mix passages from different PDFs. The backend keeps indexes in memory; restarting it clears them, so upload the PDF again to continue.
- Ollama needs enough free system memory to load the chat model. If model loading fails, close other memory-heavy apps and retry.
