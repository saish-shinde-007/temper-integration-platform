// Centralized error handler.
//
// Converts thrown errors into structured JSON responses with consistent
// shape: { error: <slug>, message: <human-readable>, details?: <any> }.
// Two concrete cases get special treatment:
//   - ZodError → 400 with the issues array
//   - 'not found in tenant' Repo errors → 404 (this is how the @temper/db
//     Repo signals tenant-scoped missing rows; see repo.ts)
// Everything else falls through to 500 with the raw message.

import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";

export function errorHandler(
  error: FastifyError | Error,
  req: FastifyRequest,
  reply: FastifyReply,
): void {
  // Zod validation errors → 400.
  if (error instanceof ZodError) {
    reply.code(400).send({
      error: "validation_failed",
      message: "Request body failed validation",
      details: error.issues,
    });
    return;
  }

  // Fastify's own validation errors (from schema option, if used).
  const maybeFastify = error as FastifyError;
  if (maybeFastify.validation) {
    reply.code(400).send({
      error: "validation_failed",
      message: maybeFastify.message,
      details: maybeFastify.validation,
    });
    return;
  }

  // Repo's tenant-scoped "not found" errors → 404.
  const msg = error.message ?? "";
  if (/not found in tenant/i.test(msg)) {
    reply.code(404).send({
      error: "not_found",
      message: msg,
    });
    return;
  }

  // Explicit statusCode from a thrown error (e.g. our own 4xx throws).
  const statusCode =
    (maybeFastify.statusCode && maybeFastify.statusCode >= 400
      ? maybeFastify.statusCode
      : undefined) ?? 500;

  if (statusCode >= 500) {
    req.log.error({ err: error }, "unhandled error");
  } else {
    req.log.warn({ err: error }, "client error");
  }

  reply.code(statusCode).send({
    error: statusCode >= 500 ? "internal_error" : "request_error",
    message: msg || "Internal server error",
  });
}
