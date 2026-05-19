export { buildBasicAuthHeader } from './auth.js';
export { MetrcClient, type MetrcClientConfig } from './client.js';
export {
  HttpClient,
  type HttpClientConfig,
  type HttpDispatcher,
  type HttpMethod,
  type HttpRequest,
  type HttpResponse,
} from './http.js';
export { createUndiciDispatcher, type UndiciDispatcherConfig } from './undici-dispatcher.js';
export type {
  CreateReceiptInput,
  CreateReceiptOutcome,
  GetReceiptInput,
  ListActiveReceiptsInput,
  MetrcReceipt,
  MetrcReceiptTransaction,
  MetrcSalesCustomerType,
  MetrcTransactionLine,
  MetrcUnitOfMeasure,
} from './types.js';
