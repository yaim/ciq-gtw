import { describe, expect, it } from "vitest";
import {
  INTERNAL_ERROR,
  INVALID_API_KEY_ERROR,
  MODEL_NOT_FOUND_ERROR,
} from "../../src/openai/errors.js";
import { encodeModelList, encodeModelObject } from "../../src/openai/models.js";

describe("openai error envelopes", () => {
  it("returns the exact authentication envelope", () => {
    expect(INVALID_API_KEY_ERROR).toEqual({
      status: 401,
      body: {
        error: {
          message: "Invalid gateway API key.",
          type: "authentication_error",
          param: null,
          code: "invalid_api_key",
        },
      },
    });
  });

  it("returns the exact model-not-found envelope without a submitted id", () => {
    expect(MODEL_NOT_FOUND_ERROR).toEqual({
      status: 404,
      body: {
        error: {
          message: "The requested model does not exist.",
          type: "invalid_request_error",
          param: "model",
          code: "model_not_found",
        },
      },
    });
    // The message is fixed; it never interpolates a requested identifier.
    expect(MODEL_NOT_FOUND_ERROR.body.error.message).not.toMatch(/model-/);
  });

  it("returns the exact internal-error envelope", () => {
    expect(INTERNAL_ERROR).toEqual({
      status: 500,
      body: {
        error: {
          message: "The gateway encountered an internal error.",
          type: "server_error",
          param: null,
          code: "internal_error",
        },
      },
    });
  });
});

describe("openai model encoding", () => {
  it("encodes a single public model object", () => {
    expect(encodeModelObject("collectiviq-fast", 1_785_933_840)).toEqual({
      id: "collectiviq-fast",
      object: "model",
      created: 1_785_933_840,
      owned_by: "collectiviq-gateway",
    });
  });

  it("encodes a list envelope with a defensive copy of the data", () => {
    const objects = [encodeModelObject("a", 1), encodeModelObject("b", 1)];
    const list = encodeModelList(objects);
    expect(list.object).toBe("list");
    expect(list.data).toHaveLength(2);
    // Mutating the source array afterwards must not affect the encoded list.
    objects.push(encodeModelObject("c", 1));
    expect(list.data).toHaveLength(2);
  });
});
