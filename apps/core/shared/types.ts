export interface ToolResult<T = unknown> {
    success: boolean;
    message: string;
    data?: T;
}