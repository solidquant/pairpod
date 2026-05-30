import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function errorHandler(
  error: FastifyError | AppError | Error,
  _req: FastifyRequest,
  reply: FastifyReply
): void {
  if (error instanceof AppError) {
    reply.status(error.statusCode).send({ error: { code: error.code, message: error.message } });
    return;
  }

  const fastifyError = error as FastifyError;
  if (fastifyError.statusCode && fastifyError.statusCode < 500) {
    reply.status(fastifyError.statusCode).send({
      error: { code: "VALIDATION_ERROR", message: fastifyError.message },
    });
    return;
  }

  reply.status(500).send({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } });
}
