export interface ToolResult<T = unknown> {
    success: boolean;
    message: string;
    speech?: string;
    data?: T;
}