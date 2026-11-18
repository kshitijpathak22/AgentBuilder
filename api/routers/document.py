"""
Document Processing API Router
Provides REST API for processing documents (PDF, PPTX, DOCX) and extracting sales-relevant content.
"""
import asyncio
from contextlib import contextmanager
import os
from pathlib import Path
import re
import shutil
import tempfile
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from api.core.auth import User, get_current_user
from api.core.config import ALLOWED_UPLOAD_EXTENSIONS, MAX_UPLOAD_SIZE_BYTES
from api.document_processor import DocumentProcessor
from api import document_ocr
from api.routers.ai import _call_llm_with_retry
from shared_logger import get_logger

logger = get_logger(__name__)

router = APIRouter(
    prefix="/documents",
    tags=["documents"],
)


# ============ Pydantic Models ============

class DocumentAnalysisRequest(BaseModel):
    content: str = Field(..., min_length=1)


class SalesSummaryRequest(BaseModel):
    content: str = Field(..., min_length=1)


class CombineDocumentsRequest(BaseModel):
    processed_files: Dict[str, str]


class ProcessedFileResponse(BaseModel):
    filename: str
    content: str
    word_count: int
    character_count: int


class DocumentAnalysisResponse(BaseModel):
    total_lines: int
    non_empty_lines: int
    word_count: int
    character_count: int
    sections: List[str]
    key_terms: List[List]
    structure_elements: Dict[str, List[str]]


class SalesContentResponse(BaseModel):
    benefits: List[str] = Field(default_factory=list)
    features: List[str] = Field(default_factory=list)
    problems: List[str] = Field(default_factory=list)
    solutions: List[str] = Field(default_factory=list)
    pricing_info: List[str] = Field(default_factory=list)
    competitive_advantages: List[str] = Field(default_factory=list)
    key_messages: List[str] = Field(default_factory=list)


class SalesSummaryResponse(BaseModel):
    summary: str
    buyer_brief: str = ""
    statistics: Dict[str, Any]
    sales_content: SalesContentResponse


class ProcessMultipleFilesResponse(BaseModel):
    processed_files: Dict[str, str]
    total_files: int
    successful_files: int
    failed_files: int


class DocumentInfoResponse(BaseModel):
    message: str
    version: str
    endpoints: Dict[str, str]


class HealthResponse(BaseModel):
    status: str
    service: str


# ============ Helper Functions ============

def _validate_file_extension(filename: Optional[str]) -> str:
    """Validate file extension and return the lowercase extension."""
    if not filename:
        raise HTTPException(status_code=400, detail="No filename provided")
    ext = Path(filename).suffix.lower()
    if ext not in ALLOWED_UPLOAD_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported file type: {ext}. Supported: {', '.join(ALLOWED_UPLOAD_EXTENSIONS)}",
        )
    return ext


def _get_safe_filename(file: UploadFile) -> str:
    """Safely extract filename from UploadFile, defaulting if None."""
    return file.filename or "unknown_file"


async def _validate_file_size(file: UploadFile) -> int:
    """Validate uploaded file size and return the size in bytes."""
    content = await file.read()
    size = len(content)

    if size > MAX_UPLOAD_SIZE_BYTES:
        max_mb = MAX_UPLOAD_SIZE_BYTES // (1024 * 1024)
        raise HTTPException(
            status_code=413,
            detail=f"File too large. Maximum size is {max_mb} MB.",
        )

    await file.seek(0)
    return size


MIN_READABLE_WORDS = 5  # below this the document is treated as having no text layer


def _process_file_by_extension(file_path: str, extension: str) -> str:
    """Process a file based on its extension using DocumentProcessor directly."""
    if extension == ".pdf":
        content = DocumentProcessor.extract_pdf_content(file_path)
    elif extension == ".pptx":
        content = DocumentProcessor.extract_pptx_content(file_path)
    elif extension == ".docx":
        content = DocumentProcessor.extract_docx_content(file_path)
    else:
        raise HTTPException(
            status_code=400, detail=f"Unsupported file type: {extension}"
        )
    if len(content.split()) < MIN_READABLE_WORDS and extension == ".pdf" and document_ocr.ocr_configured():
        # Scanned PDF: read the page images with OCR.
        logger.info("PDF has no text layer; running OCR: %s", file_path)
        try:
            content = document_ocr.ocr_pdf(file_path)
        except document_ocr.OcrError as exc:
            logger.warning("OCR failed for %s: %s", file_path, exc)
            raise HTTPException(
                status_code=422,
                detail=(
                    "This PDF looks scanned, and reading it with OCR failed. Please try again, "
                    "or upload a PDF with selectable text, or the original PowerPoint or Word file."
                ),
            )
    if len(content.split()) < MIN_READABLE_WORDS:
        if extension == ".pdf":
            detail = (
                "No readable text was found in this PDF. It looks like a scanned or image-only file. "
                "Upload a PDF with selectable text, or the original PowerPoint or Word file."
            )
        else:
            detail = "No readable text was found in this document. Text inside images is not read."
        raise HTTPException(status_code=422, detail=detail)
    return content


@contextmanager
def temp_uploaded_file(file: UploadFile, suffix: str):
    """Context manager to securely write UploadFile to disk and ensure unlink on exit."""
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as temp_file:
        shutil.copyfileobj(file.file, temp_file)
        temp_path = temp_file.name
    try:
        yield temp_path
    finally:
        if os.path.exists(temp_path):
            os.unlink(temp_path)


async def _extract_content_endpoint(
    file: UploadFile,
    expected_ext: str,
) -> Dict[str, Any]:
    safe_filename = _get_safe_filename(file)
    if not safe_filename.lower().endswith(expected_ext):
        raise HTTPException(
            status_code=400,
            detail=f"File must be a {expected_ext.upper().lstrip('.')}",
        )
    await _validate_file_size(file)

    with temp_uploaded_file(file, expected_ext) as temp_path:
        content = await run_in_threadpool(_process_file_by_extension, temp_path, expected_ext)
        return {
            "filename": file.filename,
            "content": content,
            "word_count": len(content.split()),
            "character_count": len(content),
        }


def _create_llm_sales_summary(content: str) -> str:
    """Create a concise factual context summary with the configured LLM."""
    cleaned_content = re.sub(r"[ \t]+", " ", content)
    cleaned_content = re.sub(
        r"\n{3,}",
        "\n\n",
        cleaned_content,
    ).strip()

    cleaned_content = cleaned_content[:50000]

    system_prompt = """
You summarize business, presentation, and background documents for an AI simulation counterpart.

Write one coherent, factual paragraph of exactly 6 or 7 sentences capturing the core background context.

Cover the following when the information is stated in the document:
1. The subject matter, initiative, or solution context.
2. The primary stakeholders, business units, or target audience.
3. The core business challenges, needs, or strategic objectives.
4. Key capabilities, recommendations, findings, or proposals.
5. Expected business benefits, outcomes, or impact.
6. Timelines, milestones, scope, or delivery commitments.
7. Critical constraints, governance, security, or implementation risks.

Rules:
- Use only information explicitly stated in the document.
- Do not invent or infer facts, metrics, or timelines.
- If information is not present, omit it.
- Preserve important names, numbers, durations, and terms exactly.
- Prioritize concrete facts over promotional language.
- Do not use headings, bullet points, markdown, JSON, or introductory phrases.
- Return only the final paragraph.
""".strip()

    summary = _call_llm_with_retry(
        messages=[
            {
                "role": "system",
                "content": system_prompt,
            },
            {
                "role": "user",
                "content": (
                    "Summarize the following product document:\n\n"
                    + cleaned_content
                ),
            },
        ],
        temperature=0.1,
        max_tokens=2000,
    )

    summary = summary.replace("```", "").strip()
    summary = re.sub(r"\s*\n+\s*", " ", summary)
    summary = re.sub(r"\s{2,}", " ", summary)

    if len(summary) < 100:
        raise ValueError(
            "LLM returned an unexpectedly short summary"
        )

    return summary


BUYER_BRIEF_MAX_CHARS = 3500


def _create_buyer_brief(content: str) -> str:
    """Turn the seller's material into a pre-read the AI buyer uses to test the pitch."""
    cleaned_content = re.sub(r"[ \t]+", " ", content)
    cleaned_content = re.sub(r"\n{3,}", "\n\n", cleaned_content).strip()[:50000]

    system_prompt = """
You prepare a pre-read for a skeptical buyer who is about to meet the author of the material below.
The buyer will use it to test the author's claims during the meeting.

Write plain text under exactly these headings, each on its own line followed by short lines of content:
WHAT THEY OFFER
CLAIMS AND NUMBERS
PRICING AND COMMERCIAL TERMS
PROOF POINTS
INTEGRATION, SECURITY AND DELIVERY
GAPS AND UNSUPPORTED CLAIMS
QUESTIONS A SKEPTICAL BUYER WOULD ASK

Rules:
- Use only what the material states. Copy names, numbers, percentages, prices and durations exactly.
- Under a heading with nothing stated, write "Not stated".
- GAPS AND UNSUPPORTED CLAIMS lists claims made without evidence and important topics the material does not cover.
- QUESTIONS lists 6 to 8 pointed questions that test specific claims or gaps, each on its own line.
- No markdown symbols, no introduction, no closing remarks.
- Stay under 450 words.
""".strip()

    brief = _call_llm_with_retry(
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": "Material:\n\n" + cleaned_content},
        ],
        temperature=0.1,
        max_tokens=1500,
    )
    brief = brief.replace("```", "").replace("**", "").strip()
    return brief[:BUYER_BRIEF_MAX_CHARS]


async def _buyer_brief_or_empty(content: str) -> str:
    # The brief only sharpens the live counterpart; never fail the upload because of it.
    try:
        return await run_in_threadpool(_create_buyer_brief, content)
    except Exception:
        logger.exception("Buyer brief generation failed; the session will use the summary instead")
        return ""


# ============ API Endpoints ============

@router.get("/", response_model=DocumentInfoResponse)
def document_root(current_user: User = Depends(get_current_user)):
    """Document Processing API root endpoint."""
    logger.info("Document API root called by: %s", current_user.email)
    return DocumentInfoResponse(
        message="Document Processing API",
        version="2.0",
        endpoints={
            "/upload": "Consolidated upload for one or multiple documents",
            "/summarize": "Consolidated sales summary generation",
            "/upload/single": "Upload and process a single document (alias)",
            "/upload/multiple": "Upload and process multiple documents (alias)",
            "/combine": "Combine multiple processed documents (alias)",
            "/analyze/sales-summary": "Create sales-focused summary (alias)",
        },
    )


@router.get("/health", response_model=HealthResponse)
def document_health_check(current_user: User = Depends(get_current_user)):
    """Document Processing API health check."""
    logger.info("Document health check called by: %s", current_user.email)
    return HealthResponse(status="healthy", service="Document Processing API")


# ── Consolidated Core Endpoints ───────────────────────────────────

@router.post("/upload")
async def upload_documents(
    files: List[UploadFile] = File(...),
    current_user: User = Depends(get_current_user),
):
    """
    Consolidated document upload endpoint.
    Accepts one or multiple documents (PDF, PPTX, DOCX) and extracts text content.
    """
    logger.info("Upload documents: %d file(s) by: %s", len(files), current_user.email)
    processed_files: Dict[str, str] = {}
    successful_count = 0
    failed_count = 0

    for file in files:
        safe_fname = _get_safe_filename(file)
        try:
            ext = _validate_file_extension(safe_fname)
            await _validate_file_size(file)

            with temp_uploaded_file(file, ext) as temp_path:
                content = await run_in_threadpool(_process_file_by_extension, temp_path, ext)
                processed_files[safe_fname] = content
                successful_count += 1
        except HTTPException:
            processed_files[safe_fname] = "Unsupported file type"
            failed_count += 1
        except Exception as e:
            logger.exception("Error processing %s: %s", safe_fname, str(e))
            processed_files[safe_fname] = f"Error: {str(e)}"
            failed_count += 1

    valid_files = {
        k: v for k, v in processed_files.items()
        if not v.startswith("Error") and v != "Unsupported file type"
    }
    combined_content = DocumentProcessor.combine_documents_content(valid_files) if len(valid_files) > 1 else (
        next(iter(valid_files.values())) if valid_files else ""
    )

    if len(files) == 1 and successful_count == 1:
        fname = _get_safe_filename(files[0])
        content = processed_files.get(fname, "")
        return {
            "filename": fname,
            "content": content,
            "word_count": len(content.split()),
            "character_count": len(content),
            "processed_files": processed_files,
            "combined_content": combined_content,
        }

    return {
        "processed_files": processed_files,
        "combined_content": combined_content,
        "total_files": len(files),
        "successful_files": successful_count,
        "failed_files": failed_count,
    }


@router.post("/summarize")
async def summarize_document(
    request: SalesSummaryRequest,
    current_user: User = Depends(get_current_user),
):
    """
    Consolidated document summarize endpoint.
    Accepts extracted document text, calls LLM, and returns structured sales summary.
    """
    logger.info("Summarize document called by: %s", current_user.email)
    summary = await run_in_threadpool(_create_llm_sales_summary, request.content)
    return {
        "summary": summary,
        "word_count": len(summary.split()),
        "character_count": len(summary),
    }


# ── Backward-Compatible Aliases for Frontend ─────────────────────

@router.post("/upload/single", response_model=ProcessedFileResponse)
async def upload_single_document(
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
):
    """Upload and process a single document (PDF, PPTX, or DOCX)."""
    safe_filename = _get_safe_filename(file)
    logger.info("Upload single document: %s by: %s", safe_filename, current_user.email)

    ext = _validate_file_extension(safe_filename)
    await _validate_file_size(file)

    with temp_uploaded_file(file, ext) as temp_path:
        content = await run_in_threadpool(_process_file_by_extension, temp_path, ext)
        word_count = len(content.split())
        char_count = len(content)

        logger.info(
            "Processed %s: %d words, %d chars", file.filename, word_count, char_count
        )
        return ProcessedFileResponse(
            filename=safe_filename,
            content=content,
            word_count=word_count,
            character_count=char_count,
        )


@router.post("/upload/multiple", response_model=ProcessMultipleFilesResponse)
async def upload_multiple_documents(
    files: List[UploadFile] = File(...),
    current_user: User = Depends(get_current_user),
):
    """Upload and process multiple documents (PDF, PPTX, or DOCX)."""
    logger.info(
        "Upload multiple documents: %d files by: %s",
        len(files),
        current_user.email,
    )

    processed_files: Dict[str, str] = {}
    successful_count = 0
    failed_count = 0

    for file in files:
        safe_fname = _get_safe_filename(file)
        try:
            ext = _validate_file_extension(safe_fname)
            await _validate_file_size(file)

            with temp_uploaded_file(file, ext) as temp_path:
                content = await run_in_threadpool(_process_file_by_extension, temp_path, ext)
                processed_files[safe_fname] = content
                successful_count += 1

        except HTTPException as exc:
            processed_files[safe_fname] = f"Error: {exc.detail}"
            failed_count += 1
        except Exception as e:
            logger.exception("Error processing %s: %s", safe_fname, str(e))
            processed_files[safe_fname] = f"Error: {str(e)}"
            failed_count += 1

    logger.info(
        "Multiple upload complete: %d total, %d success, %d failed",
        len(files),
        successful_count,
        failed_count,
    )
    return ProcessMultipleFilesResponse(
        processed_files=processed_files,
        total_files=len(files),
        successful_files=successful_count,
        failed_files=failed_count,
    )


@router.post("/combine")
async def combine_documents_content(
    request: CombineDocumentsRequest,
    current_user: User = Depends(get_current_user),
):
    """Combine content from multiple processed files."""
    logger.info(
        "Combine documents: %d files by: %s",
        len(request.processed_files),
        current_user.email,
    )
    combined = DocumentProcessor.combine_documents_content(request.processed_files)
    return {
        "combined_content": combined,
        "total_files": len(request.processed_files),
        "word_count": len(combined.split()),
        "character_count": len(combined),
    }


@router.post("/analyze/sales-summary", response_model=SalesSummaryResponse)
async def create_sales_summary(
    request: SalesSummaryRequest,
    current_user: User = Depends(get_current_user),
):
    """Create a sales-focused summary of document content via LLM."""
    logger.info("Create sales summary called by: %s", current_user.email)
    summary, buyer_brief = await asyncio.gather(
        run_in_threadpool(_create_llm_sales_summary, request.content),
        _buyer_brief_or_empty(request.content),
    )
    analysis = DocumentProcessor.analyze_document_structure(request.content)
    return SalesSummaryResponse(
        summary=summary,
        buyer_brief=buyer_brief,
        statistics={
            "word_count": analysis["word_count"],
            "sections": len(analysis["sections"]),
            "headers": len(analysis["structure_elements"]["headers"]),
            "bullet_points": len(analysis["structure_elements"]["bullet_points"]),
        },
        sales_content=SalesContentResponse(),
    )


@router.post("/extract/pdf")
async def extract_pdf_content(
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
):
    """Extract text content from a PDF file."""
    logger.info("Extract PDF: %s by: %s", file.filename, current_user.email)
    return await _extract_content_endpoint(file, ".pdf")


@router.post("/extract/pptx")
async def extract_pptx_content(
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
):
    """Extract text content from a PowerPoint file."""
    logger.info("Extract PPTX: %s by: %s", file.filename, current_user.email)
    return await _extract_content_endpoint(file, ".pptx")


@router.post("/extract/docx")
async def extract_docx_content(
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
):
    """Extract text content from a Word document."""
    logger.info("Extract DOCX: %s by: %s", file.filename, current_user.email)
    return await _extract_content_endpoint(file, ".docx")


@router.post("/analyze/structure", response_model=DocumentAnalysisResponse)
async def analyze_document_structure(
    request: DocumentAnalysisRequest,
    current_user: User = Depends(get_current_user),
):
    """Analyze document structure and extract key information."""
    logger.info("Analyze structure called by: %s", current_user.email)
    analysis = DocumentProcessor.analyze_document_structure(request.content)
    return DocumentAnalysisResponse(**analysis)


@router.post("/process/full")
async def process_document_full(
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
):
    """Process a document fully: extract, analyze, and summarize."""
    logger.info("Full process: %s by: %s", file.filename, current_user.email)

    safe_filename = _get_safe_filename(file)
    ext = _validate_file_extension(safe_filename)
    await _validate_file_size(file)

    with temp_uploaded_file(file, ext) as temp_path:
        content = await run_in_threadpool(_process_file_by_extension, temp_path, ext)
        structure = DocumentProcessor.analyze_document_structure(content)
        summary = await run_in_threadpool(_create_llm_sales_summary, content)

        logger.info("Full processing complete for: %s", file.filename)
        return {
            "filename": file.filename,
            "file_type": ext,
            "extracted_content": content,
            "structure_analysis": structure,
            "sales_summary": summary,
            "metadata": {
                "word_count": len(content.split()),
                "character_count": len(content),
                "total_lines": structure["total_lines"],
                "non_empty_lines": structure["non_empty_lines"],
            },
        }
