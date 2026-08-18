import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { shiftSpan } from "../src/ranges";

const span = { start: 10, end: 20 };

describe("shiftSpan", () => {
  describe("insert", () => {
    it("moves a span that sits after the insertion", () => {
      assert.deepEqual(shiftSpan(span, 5, 5, 3), { start: 13, end: 23 });
    });

    it("moves a span when the insertion lands on its start", () => {
      assert.deepEqual(shiftSpan(span, 10, 10, 3), { start: 13, end: 23 });
    });

    it("grows a span when the insertion lands inside it", () => {
      assert.deepEqual(shiftSpan(span, 15, 15, 3), { start: 10, end: 23 });
    });

    it("leaves a span alone when the insertion lands on its end", () => {
      assert.deepEqual(shiftSpan(span, 20, 20, 3), { start: 10, end: 20 });
    });

    it("leaves a span alone when the insertion sits after it", () => {
      assert.deepEqual(shiftSpan(span, 25, 25, 3), { start: 10, end: 20 });
    });
  });

  describe("delete", () => {
    it("pulls a span back when the deletion sits before it", () => {
      assert.deepEqual(shiftSpan(span, 5, 8, 0), { start: 7, end: 17 });
    });

    it("pulls a span back when the deletion ends on its start", () => {
      assert.deepEqual(shiftSpan(span, 5, 10, 0), { start: 5, end: 15 });
    });

    it("trims the head of a span the deletion overlaps", () => {
      assert.deepEqual(shiftSpan(span, 8, 12, 0), { start: 8, end: 16 });
    });

    it("trims the tail of a span the deletion overlaps", () => {
      assert.deepEqual(shiftSpan(span, 18, 25, 0), { start: 10, end: 18 });
    });

    it("empties a span the deletion covers exactly", () => {
      assert.deepEqual(shiftSpan(span, 10, 20, 0), { start: 10, end: 10 });
    });

    it("empties a span the deletion swallows", () => {
      assert.deepEqual(shiftSpan(span, 0, 30, 0), { start: 0, end: 0 });
    });

    it("leaves a span alone when the deletion starts on its end", () => {
      assert.deepEqual(shiftSpan(span, 20, 25, 0), { start: 10, end: 20 });
    });

    it("leaves a span alone when the deletion sits after it", () => {
      assert.deepEqual(shiftSpan(span, 25, 30, 0), { start: 10, end: 20 });
    });
  });

  describe("replace", () => {
    it("pushes a span past text that replaces its head", () => {
      assert.deepEqual(shiftSpan(span, 10, 15, 8), { start: 18, end: 23 });
    });

    it("collapses a span that is replaced whole", () => {
      assert.deepEqual(shiftSpan(span, 10, 20, 5), { start: 15, end: 15 });
    });

    it("keeps the tail of a span whose head is replaced from outside", () => {
      assert.deepEqual(shiftSpan(span, 5, 15, 2), { start: 7, end: 12 });
    });

    it("shrinks a span around a replacement that sits inside it", () => {
      assert.deepEqual(shiftSpan(span, 12, 15, 1), { start: 10, end: 18 });
    });

    it("never lets the end fall behind the start", () => {
      assert.deepEqual(shiftSpan({ start: 14, end: 16 }, 10, 20, 8), { start: 18, end: 18 });
    });
  });
});
