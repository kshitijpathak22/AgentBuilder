# document_processor.py
import PyPDF2
from pathlib import Path
from typing import List, Dict, Optional

from shared_logger import get_logger

logger = get_logger(__name__)


class DocumentProcessor:
    """Handle document processing and content extraction"""
    
    @staticmethod
    def extract_pdf_content(file_path: str) -> str:
        """Extract text content from PDF file."""
        try:
            logger.info(f"Extracting PDF content from file: {file_path}")
            with open(file_path, "rb") as file:
                pdf_reader = PyPDF2.PdfReader(file)
                content = []
                for page_num, page in enumerate(pdf_reader.pages, 1):
                    page_text = page.extract_text()
                    if page_text and page_text.strip():
                        content.append(f"\n--- Page {page_num} ---\n{page_text}\n")
                logger.info(f"Successfully extracted {len(pdf_reader.pages)} pages from PDF")
                return "".join(content)
        except Exception as e:
            logger.exception(f"Error extracting PDF content: {str(e)}")
            raise
    
    @staticmethod
    def extract_pptx_content(file_path: str) -> str:
        """Extract text content from PowerPoint file."""
        try:
            from pptx import Presentation
            
            logger.info(f"Extracting PPTX content from file: {file_path}")
            prs = Presentation(file_path)
            content = []
            for slide_num, slide in enumerate(prs.slides, 1):
                content.append(f"\n--- Slide {slide_num} ---\n")
                for shape in slide.shapes:
                    if hasattr(shape, "text") and shape.text.strip():
                        content.append(f"{shape.text}\n")
                    if hasattr(shape, "table"):
                        for row in shape.table.rows:
                            row_text = [cell.text.strip() for cell in row.cells if cell.text.strip()]
                            if row_text:
                                content.append(f"Table: {' | '.join(row_text)}\n")
            logger.info(f"Successfully extracted {len(prs.slides)} slides from PPTX")
            return "".join(content)
        except Exception as e:
            logger.exception(f"Error extracting PowerPoint content: {str(e)}")
            raise
    
    @staticmethod
    def extract_docx_content(file_path: str) -> str:
        """Extract text content from Word document."""
        try:
            from docx import Document
            
            logger.info(f"Extracting DOCX content from file: {file_path}")
            doc = Document(file_path)
            content = []
            for paragraph in doc.paragraphs:
                if paragraph.text.strip():
                    content.append(f"{paragraph.text}\n")
            for table in doc.tables:
                for row in table.rows:
                    row_text = [cell.text.strip() for cell in row.cells if cell.text.strip()]
                    if row_text:
                        content.append(f"Table: {' | '.join(row_text)}\n")
            logger.info(f"Successfully extracted DOCX content: {len(doc.paragraphs)} paragraphs")
            return "".join(content)
        except Exception as e:
            logger.exception(f"Error extracting Word document content: {str(e)}")
            raise
    
    @staticmethod
    def process_multiple_files(file_list) -> Dict[str, str]:
        """
        Process multiple files and return content dictionary
        
        Args:
            file_list: List of file objects or file paths
            
        Returns:
            Dictionary with filename as key and content as value
        """
        processed_files = {}
        logger.info(f"Processing {len(file_list)} files")
        
        for file in file_list:
            try:
                # Determine file type and process accordingly
                filename = file.name if hasattr(file, 'name') else str(file)
                file_extension = Path(filename).suffix.lower()
                logger.debug(f"Processing file: {filename} (type: {file_extension})")
                
                if file_extension == '.pdf':
                    content = DocumentProcessor.extract_pdf_content(file)
                elif file_extension == '.pptx':
                    content = DocumentProcessor.extract_pptx_content(file)
                elif file_extension == '.docx':
                    content = DocumentProcessor.extract_docx_content(file)
                else:
                    logger.warning(f"Unsupported file type: {file_extension} for file: {filename}")
                    content = f"Unsupported file type: {file_extension}"
                    
                processed_files[filename] = content
                
            except Exception as e:
                logger.exception(f"Error processing file {filename}: {str(e)}")
                processed_files[filename] = f"Error processing file: {str(e)}"
                
        logger.info(f"Completed processing {len(file_list)} files. Success: {len([v for v in processed_files.values() if not v.startswith('Error')])}")
        return processed_files
    
    @staticmethod
    def combine_documents_content(processed_files: Dict[str, str]) -> str:
        """
        Combine content from multiple processed files
        
        Args:
            processed_files: Dictionary from process_multiple_files
            
        Returns:
            Combined content string
        """
        logger.info(f"Combining content from {len(processed_files)} files")
        combined_content = ""
        
        for filename, content in processed_files.items():
            logger.debug(f"Adding content from: {filename}")
            combined_content += f"\n\n{'='*50}\n"
            combined_content += f"FILE: {filename}\n"
            combined_content += f"{'='*50}\n"
            combined_content += content
            
        logger.info(f"Combined content size: {len(combined_content)} characters")
        return combined_content
    
    @staticmethod
    def analyze_document_structure(content: str) -> Dict:
        """
        Analyze document structure and extract key information
        
        Args:
            content: Extracted document content
            
        Returns:
            Analysis dictionary
        """
        logger.debug(f"Analyzing document structure. Content length: {len(content)} characters")
        lines = content.split('\n')
        analysis = {
            'total_lines': len(lines),
            'non_empty_lines': len([line for line in lines if line.strip()]),
            'word_count': len(content.split()),
            'character_count': len(content),
            'sections': [],
            'key_terms': [],
            'structure_elements': {
                'headers': [],
                'bullet_points': [],
                'numbered_lists': [],
                'tables': []
            }
        }
        
        # Identify sections and structure
        for i, line in enumerate(lines):
            line = line.strip()
            if not line:
                continue
                
            # Detect headers (lines with --- or ===)
            if line.startswith('---') or line.startswith('==='):
                if i + 1 < len(lines):
                    next_line = lines[i + 1].strip()
                    if next_line:
                        analysis['sections'].append(next_line)
                        analysis['structure_elements']['headers'].append(next_line)
            
            # Detect bullet points
            if line.startswith('•') or line.startswith('-') or line.startswith('*'):
                analysis['structure_elements']['bullet_points'].append(line)
                
            # Detect numbered lists
            if line and line[0].isdigit() and '.' in line[:5]:
                analysis['structure_elements']['numbered_lists'].append(line)
                
            # Detect tables
            if 'Table:' in line or '|' in line:
                analysis['structure_elements']['tables'].append(line)
        
        # Extract key terms (simple approach)
        words = content.lower().split()
        word_freq = {}
        for word in words:
            word = word.strip('.,!?:;')
            if len(word) > 4:  # Only consider words longer than 4 characters
                word_freq[word] = word_freq.get(word, 0) + 1
        
        # Get top 10 most frequent terms
        analysis['key_terms'] = sorted(word_freq.items(), key=lambda x: x[1], reverse=True)[:10]
        
        logger.info(f"Document analysis complete. Lines: {analysis['total_lines']}, Words: {analysis['word_count']}, Sections: {len(analysis['sections'])}")
        return analysis


if __name__ == "__main__":
    processor = DocumentProcessor()
    print("Document processor ready for use with sales coaching system.")