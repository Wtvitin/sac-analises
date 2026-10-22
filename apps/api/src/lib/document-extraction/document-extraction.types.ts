export type ExtractionConfidence = 'IDENTIFIED' | 'REVIEW_REQUIRED' | 'UNIDENTIFIED';
export type ExtractionConfidenceLevel = 'HIGH' | 'MEDIUM' | 'LOW';

export interface CandidateField<T = string> {
  value: T;
  sourceSnippet?: string;
  confidence: ExtractionConfidence;
  confidenceLevel?: ExtractionConfidenceLevel;
  warning?: string;
  requiresReview: boolean;
  candidateOrderNumbers?: string[];
}

export interface ExtractedItem {
  key: string;
  code: string;
  description: string;
  batch: string;
  quantity: number;
  note: string;
  confidence: ExtractionConfidence;
  confidenceLevel?: ExtractionConfidenceLevel;
  requiresReview?: boolean;
  sourceSnippet?: string;
  warning?: string;
  rawBatch?: string;
  batchStatus?: 'VALID' | 'EMPTY' | 'AMBIGUOUS' | 'MULTIPLE';
  batchCandidates?: string[];
  batchNotice?: string;
}

export interface AdditionalFieldInfo {
  label: string;
  value: string;
  category?: 'FISCAL' | 'CLIENTE' | 'CONTATO' | 'SENSITIVE' | 'CLINICO' | 'OUTROS';
  note?: string;
  isSensitive?: boolean;
}

export interface ReferencedDocumentFile {
  name: string;
  note: string;
  attached: boolean;
}

export type ExtractedReferenceType =
  | 'ORDER'
  | 'INVOICE'
  | 'SERVICE_ORDER'
  | 'PROTOCOL'
  | 'ATTENDANCE'
  | 'CUSTOMER_CODE'
  | 'INTERNAL_DOC'
  | 'OTHER';

export interface ExtractedReference {
  type: ExtractedReferenceType;
  value: string;
  label: string;
  confidence: ExtractionConfidence;
  note?: string;
}

export interface FormExtractionResult {
  format: 'PDF' | 'IMAGE' | 'XLSX';
  isScannedPdf?: boolean;
  modelId?: 'OUTLOOK_MS_FORMS' | 'KEY_VALUE_FORM' | 'GENERIC_TEXT' | 'TABULAR_ATTENDANCE';
  modelName?: string;
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
  suggestedReason?: CandidateField;
  suggestedSubreason?: CandidateField;
  invoiceNumber?: CandidateField;
  candidateReferences?: ExtractedReference[];
  items: ExtractedItem[];
  additionalInfo?: AdditionalFieldInfo[];
  referencedFiles?: ReferencedDocumentFile[];
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
