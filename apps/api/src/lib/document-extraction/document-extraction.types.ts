export type ExtractionConfidence = 'IDENTIFIED' | 'REVIEW_REQUIRED' | 'UNIDENTIFIED';

export interface CandidateField<T = string> {
  value: T;
  sourceSnippet?: string;
  confidence: ExtractionConfidence;
  warning?: string;
  requiresReview: boolean;
}

export interface ExtractedItem {
  key: string;
  code: string;
  description: string;
  batch: string;
  quantity: number;
  note: string;
  confidence: ExtractionConfidence;
}

export interface FormExtractionResult {
  format: 'PDF' | 'IMAGE' | 'XLSX';
  isScannedPdf?: boolean;
  externalTicket: CandidateField;
  customerName: CandidateField;
  customerContact?: CandidateField;
  customerAddress?: CandidateField;
  openedAt: CandidateField;
  channelName?: CandidateField;
  channelId?: CandidateField;
  orderNumber: CandidateField;
  description: CandidateField;
  internalNote?: CandidateField;
  suggestedAssignee?: CandidateField;
  items: ExtractedItem[];
  summary: {
    totalIdentified: number;
    totalReviewRequired: number;
    totalUnidentified: number;
  };
  warnings: string[];
  existingCustomer?: { id: string; name: string } | null;
  potentialDuplicate?: {
    found: boolean;
    ticket?: string;
    reason?: string;
  } | null;
}

export interface RawDocumentText {
  text: string;
  format: 'PDF' | 'IMAGE' | 'XLSX';
  numPages?: number;
  isScanned?: boolean;
  tableData?: Array<Record<string, string>>;
  warnings: string[];
}
