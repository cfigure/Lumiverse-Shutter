declare module 'lumiverse-spindle-types' {
  export type LlmMessageContentPart = { type: string; text?: string; [key: string]: unknown }
  export type LlmMessageDTO = {
    role: string
    content: string | LlmMessageContentPart[]
    [key: string]: unknown
  }

  export interface SpindleFloatWidgetHandle {
    root: HTMLElement
    setVisible(visible: boolean): void
    setSize(width: number, height: number): void
    destroy(): void
  }

  export interface SpindleModalHandle {
    root: HTMLElement
    dismiss(): void
    setTitle(title: string): void
    onDismiss(callback: () => void): (() => void) | void
  }

  export interface SpindleComponentHandle {
    destroy(): void
    setValue?(value: unknown): void
    setChecked?(checked: boolean): void
    setDisabled?(disabled: boolean): void
    setOpen?(open: boolean): void
    [key: string]: unknown
  }

  export interface SpindleFrontendContext {
    sendToBackend(payload: unknown): void
    onBackendMessage(callback: (payload: unknown) => void): () => void
    getActiveChat(): { chatId: string | null; [key: string]: unknown }
    permissions: {
      getGranted(): Promise<string[]>
      request(permissions: string[], options?: { reason?: string }): Promise<string[]>
    }
    events: {
      on(event: string, callback: (payload: any) => void): () => void
    }
    dom: {
      addStyle(css: string): () => void
      cleanup(): void
      inject(target: Element | string, html: string, position?: InsertPosition): HTMLElement
      uninject(element: Element): void
      findMessageElement(messageId: string): HTMLElement | null
      getMessageId(element: Element): string | null
      query?(selector: string): HTMLElement | null
    }
    components: {
      mountSpinner(target: Element, options?: Record<string, unknown>): SpindleComponentHandle
      mountCheckbox(target: Element, options: Record<string, unknown>): SpindleComponentHandle
      mountSwitch(target: Element, options: Record<string, unknown>): SpindleComponentHandle
      mountCollapsibleSection(target: Element, options: Record<string, unknown>): SpindleComponentHandle & { body: HTMLElement }
      mountNumberStepper(target: Element, options: Record<string, unknown>): SpindleComponentHandle
    }
    ui: {
      mount(slot: string): HTMLElement
      showModal(options: Record<string, unknown>): SpindleModalHandle
      showConfirm(options: Record<string, unknown>): Promise<{ confirmed: boolean }>
      showContextMenu(options: Record<string, unknown>): Promise<{ selectedKey?: string }>
      createFloatWidget(options: Record<string, unknown>): SpindleFloatWidgetHandle
      registerInputBarAction(options: Record<string, unknown>): {
        onClick(callback: () => void): void
        destroy(): void
      }
    }
  }

  export interface SpindleAPI {
    userStorage: {
      read(path: string, userId?: string): Promise<string>
      write(path: string, data: string, userId?: string): Promise<void>
      delete(path: string, userId?: string): Promise<void>
      list(prefix?: string, userId?: string): Promise<string[]>
      exists(path: string, userId?: string): Promise<boolean>
      mkdir(path: string, userId?: string): Promise<void>
      move(from: string, to: string, userId?: string): Promise<void>
      stat(path: string, userId?: string): Promise<{ exists: boolean; isFile: boolean; isDirectory: boolean; sizeBytes: number; modifiedAt: string }>
      getJson<T>(path: string, options?: { fallback?: T; userId?: string }): Promise<T>
      setJson(path: string, value: unknown, options?: { indent?: number; userId?: string }): Promise<void>
    }
    chat: {
      getMessages(chatId: string): Promise<unknown[]>
      updateMessage(chatId: string, messageId: string, patch: Record<string, unknown>): Promise<void>
    }
    permissions: {
      has(permission: string): boolean
      onChanged(callback: (event: { permission: string; granted: boolean }) => void): (() => void) | void
      onDenied(callback: (event: { permission: string; operation: string }) => void): (() => void) | void
    }
    toast: {
      info(message: string, options?: { userId?: string }): void
      success(message: string, options?: { userId?: string }): void
      warning(message: string, options?: { userId?: string }): void
      error(message: string, options?: { userId?: string }): void
    }
    log: {
      info(message: string): void
      warn(message: string): void
      error(message: string): void
      debug?(message: string): void
    }
    onFrontendMessage(callback: (payload: unknown, userId: string) => void | Promise<void>): void
    sendToFrontend(payload: unknown, userId?: string): void
    registerInterceptor(
      callback: (messages: LlmMessageDTO[], context?: unknown) => LlmMessageDTO[] | Promise<LlmMessageDTO[]>,
      priority?: number,
    ): void
  }
}
