import asyncio
import json
import os
import queue
import tempfile
import uuid
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from rag import (
    EMBEDDING_MODEL,
    LLM_MODEL,
    create_vectorstore,
    deduplicate_documents,
    document_page_number,
    generate_answer_stream,
    load_pdf,
    retrieve_documents,
    split_documents,
)


BASE_DIR = Path(__file__).resolve().parent
FRONTEND_DIR = BASE_DIR / "frontend"
MAX_UPLOAD_BYTES = 50 * 1024 * 1024
documents_by_id: dict[str, dict[str, Any]] = {}

app = FastAPI(title="RAG Document Chatbot API")
app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")


class ChatRequest(BaseModel):
    document_id: str
    question: str


def server_event(event: str, data: dict[str, Any]) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


@app.get("/")
async def index():
    return FileResponse(FRONTEND_DIR / "index.html")


@app.get("/api/health")
async def health():
    return {
        "status": "ok",
        "embedding_model": EMBEDDING_MODEL,
        "llm_model": LLM_MODEL,
    }


@app.post("/api/documents")
async def upload_document(file: UploadFile = File(...)):
    filename = Path(file.filename or "document.pdf").name
    if not filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=415, detail="Please upload a PDF file.")

    content = await file.read(MAX_UPLOAD_BYTES + 1)
    if len(content) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="PDF must be smaller than 50 MB.")
    if not content:
        raise HTTPException(status_code=400, detail="The uploaded PDF is empty.")

    events: queue.Queue[dict[str, Any]] = queue.Queue()
    loop = asyncio.get_running_loop()
    document_id = str(uuid.uuid4())

    def send_progress(event: str, **data: Any) -> None:
        loop.call_soon_threadsafe(events.put, {"event": event, "data": data})

    def process_pdf() -> dict[str, Any]:
        temp_path = None
        try:
            with tempfile.NamedTemporaryFile(delete=False, suffix=".pdf") as temp_file:
                temp_file.write(content)
                temp_path = temp_file.name

            send_progress("stage", message="Reading PDF pages...")
            pages = load_pdf(temp_path)
            if not pages:
                raise ValueError("No pages were found in this PDF.")

            send_progress("stage", message=f"Extracted {len(pages)} page(s). Splitting text...")
            chunks = split_documents(pages)
            if not chunks:
                raise ValueError(
                    "No readable text was extracted. This PDF may contain scanned images only."
                )

            send_progress(
                "stage",
                message=f"Created {len(chunks)} chunks. Generating embeddings...",
            )
            vectorstore = create_vectorstore(
                chunks,
                progress_callback=lambda completed, total: send_progress(
                    "progress",
                    completed=completed,
                    total=total,
                ),
            )
            return {
                "vectorstore": vectorstore,
                "pages": len(pages),
                "chunks": len(chunks),
                "size": len(content),
            }
        finally:
            if temp_path and os.path.exists(temp_path):
                os.remove(temp_path)

    async def stream_upload_events():
        events.put({"event": "stage", "data": {"message": "Starting document processing..."}})
        task = asyncio.create_task(asyncio.to_thread(process_pdf))
        try:
            while True:
                try:
                    message = events.get_nowait()
                except queue.Empty:
                    if task.done():
                        break
                    await asyncio.sleep(0.1)
                else:
                    yield server_event(message["event"], message["data"])

            result = await task
            documents_by_id[document_id] = {
                "name": filename,
                "vectorstore": result.pop("vectorstore"),
                **result,
            }
            yield server_event(
                "complete",
                {"document_id": document_id, "name": filename, **result},
            )
        except Exception as error:
            yield server_event("error", {"message": str(error)})

    return StreamingResponse(
        stream_upload_events(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/api/chat")
async def chat(request: ChatRequest):
    document = documents_by_id.get(request.document_id)
    if document is None:
        raise HTTPException(
            status_code=404,
            detail="This document is no longer available. Please upload it again.",
        )
    question = request.question.strip()
    if not question:
        raise HTTPException(status_code=400, detail="Enter a question.")

    async def stream_chat_events():
        try:
            results = await asyncio.to_thread(
                retrieve_documents,
                document["vectorstore"],
                question,
            )
            results = deduplicate_documents(results)
            sources = [
                {
                    "page": document_page_number(item),
                    "text": item.page_content,
                }
                for item in results
            ]
            yield server_event("sources", {"sources": sources})

            if not results:
                yield server_event(
                    "token",
                    {"text": "I could not find the answer in the uploaded document."},
                )
            else:
                token_stream = iter(generate_answer_stream(question, results))
                while True:
                    token = await asyncio.to_thread(next, token_stream, None)
                    if token is None:
                        break
                    yield server_event("token", {"text": token})

            yield server_event("complete", {})
        except Exception as error:
            yield server_event("error", {"message": str(error)})

    return StreamingResponse(
        stream_chat_events(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
