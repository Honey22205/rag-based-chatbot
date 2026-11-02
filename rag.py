import re
import uuid

from langchain_community.document_loaders import PyPDFLoader
from langchain_text_splitters import RecursiveCharacterTextSplitter
from langchain_ollama import OllamaEmbeddings, ChatOllama
from langchain_chroma import Chroma


# -----------------------------
# Local Ollama models
# -----------------------------

EMBEDDING_MODEL = "nomic-embed-text:latest"
LLM_MODEL = "gemma2:2b"


# -----------------------------
# Embedding model
# -----------------------------

embeddings = OllamaEmbeddings(
    model=EMBEDDING_MODEL
)


# -----------------------------
# Chat model
# -----------------------------

llm = ChatOllama(
    model=LLM_MODEL,
    temperature=0
)


# -----------------------------
# Load PDF
# -----------------------------

def load_pdf(file_path):

    loader = PyPDFLoader(file_path)

    documents = loader.load()

    return documents


# -----------------------------
# Split document
# -----------------------------

def split_documents(documents):

    text_splitter = RecursiveCharacterTextSplitter(
        chunk_size=1000,
        chunk_overlap=200
    )

    chunks = text_splitter.split_documents(documents)

    return chunks


# -----------------------------
# Create vector database
# -----------------------------

def create_vectorstore(chunks, progress_callback=None):

    # Create empty Chroma collection
    vectorstore = Chroma(
        collection_name=f"rag_{uuid.uuid4().hex}",
        embedding_function=embeddings
    )

    # Process embeddings in small batches
    batch_size = 20

    total_chunks = len(chunks)

    for i in range(0, total_chunks, batch_size):

        batch = chunks[i:i + batch_size]

        start = i + 1
        end = min(i + batch_size, total_chunks)

        print(
            f"Embedding chunks {start}-{end} "
            f"of {total_chunks}"
        )

        vectorstore.add_documents(batch)
        if progress_callback:
            progress_callback(end, total_chunks)

    print("All chunks embedded successfully.")

    return vectorstore


def document_page_number(document):
    page = document.metadata.get("page")
    if isinstance(page, int) and not isinstance(page, bool):
        return page + 1
    if isinstance(page, str) and page.strip().isdigit():
        return int(page.strip()) + 1
    return None


def deduplicate_documents(documents):
    unique_documents = []
    seen = set()

    for document in documents:
        page = document_page_number(document)
        normalized_text = " ".join(document.page_content.split())
        key = (page, normalized_text)
        if normalized_text and key not in seen:
            seen.add(key)
            unique_documents.append(document)

    return unique_documents


# -----------------------------
# Retrieve relevant chunks
# -----------------------------

def retrieve_documents(vectorstore, question):
    if re.search(r"\bgenre\b|\btype of (?:book|story|writing)\b", question, re.IGNORECASE):
        search_queries = [(
            f"{question} literary genre book form fiction nonfiction novel memoir "
            "poetry play biography subject matter themes"
        )]
        result_count = 8
    elif re.search(
        r"\bdialogue\b|\bconversation\b|\bexchange between\b|\btwo characters\b|\bquote\b",
        question,
        re.IGNORECASE,
    ):
        search_queries = [
            question,
            (
                "direct spoken dialogue conversation exchange between two characters; "
                "one speaker asks or says something and another speaker replies or answers; "
                "quoted speech, character names, said, asked, replied"
            ),
            (
                "a scene with two distinct people speaking to each other, question and response, "
                "dialogue lines, quotation marks"
            ),
        ]
        result_count = 8
    else:
        search_queries = [question]
        result_count = 4

    results = []
    for search_query in search_queries:
        results.extend(
            vectorstore.similarity_search(
                search_query,
                k=result_count,
            )
        )

    return deduplicate_documents(results)[:result_count]


# -----------------------------
# Generate answer
# -----------------------------

def _create_prompt(question, documents):
    context = "\n\n".join(
        (
            f"[Page {document_page_number(document)}]\n"
            if document_page_number(document) is not None
            else ""
        )
        + document.page_content
        for document in documents
    )

    prompt = f"""
You are a document question-answering assistant.

Answer the user's question using the document context as evidence.

For directly stated facts, report what the context says. Some questions,
such as a book's genre, may require a reasonable inference from its form,
themes, and content. When the context supports an inference, give the most
likely answer, label it clearly as an inference, and briefly explain the
evidence. Do not pretend an inference is explicitly stated in the document.

If there is not enough evidence even to make a reasonable inference, say:

"I could not determine that from the available passages in the uploaded document."

For requests to quote dialogue, only quote exact words that appear in the
provided passages, and keep the quote under 90 characters. Verify that the
passage shows two distinct speakers in an exchange. A poem, a narrator's
internal monologue, a letter to an absent person, or a heading mentioning
"dialogue" is not by itself a conversation between two characters. If no
clear exchange is present, say you could not find a verifiable two-speaker
exchange in the retrieved passages; do not invent one.

Do not make up information. Distinguish the document's author from people
mentioned or cited in its text. For an author question, only name someone if
the context explicitly identifies that person as the document's author.
Include the supporting page number in your answer, for example "(p. 1)".

DOCUMENT CONTEXT:
{context}

USER QUESTION:
{question}

ANSWER:
"""

    return prompt


def generate_answer_stream(question, documents):
    prompt = _create_prompt(question, documents)

    for chunk in llm.stream(prompt):
        if chunk.content:
            yield chunk.content


def generate_answer(question, documents):
    return "".join(generate_answer_stream(question, documents))
