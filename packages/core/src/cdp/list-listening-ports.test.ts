// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";

import {
  parseLsofListenPorts,
  parseWindowsNetstatListeners,
} from "./list-listening-ports.js";

describe("parseWindowsNetstatListeners", () => {
  const header = [
    "",
    "Active Connections",
    "",
    "  Proto  Local Address          Foreign Address        State           PID",
  ];

  it("returns listening TCP ports owned by the PID", () => {
    const stdout = [
      ...header,
      "  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1096",
      "  TCP    127.0.0.1:9222         0.0.0.0:0              LISTENING       19780",
      "  TCP    127.0.0.1:3928         0.0.0.0:0              LISTENING       19780",
      "  TCP    [::]:135               [::]:0                 LISTENING       1096",
    ].join("\r\n");

    expect(parseWindowsNetstatListeners(stdout, 19780)).toEqual([3928, 9222]);
  });

  it("keeps a listener whose port also appears on TIME_WAIT rows owned by PID 0 (pid-port regression)", () => {
    // Every HTTP probe against the launcher's CDP endpoint leaves a server-side
    // TIME_WAIT row for the same local port, attributed to PID 0. pid-port's
    // port→pid map let those rows overwrite the LISTENING row, making the
    // launcher appear to have no CDP port at all.
    const stdout = [
      ...header,
      "  TCP    127.0.0.1:9222         0.0.0.0:0              LISTENING       19780",
      "  TCP    127.0.0.1:9222         127.0.0.1:51301        ESTABLISHED     19780",
      "  TCP    127.0.0.1:9222         127.0.0.1:51404        TIME_WAIT       0",
      "  TCP    127.0.0.1:9222         127.0.0.1:51407        TIME_WAIT       0",
    ].join("\r\n");

    expect(parseWindowsNetstatListeners(stdout, 19780)).toEqual([9222]);
  });

  it("excludes established/client-side ports of the same PID", () => {
    const stdout = [
      ...header,
      "  TCP    127.0.0.1:9222         0.0.0.0:0              LISTENING       19780",
      "  TCP    127.0.0.1:51822        127.0.0.1:60123        ESTABLISHED     19780",
      "  TCP    192.168.1.5:52001      142.250.1.100:443      ESTABLISHED     19780",
    ].join("\r\n");

    expect(parseWindowsNetstatListeners(stdout, 19780)).toEqual([9222]);
  });

  it("detects listeners without relying on the localized State column", () => {
    // German Windows localizes LISTENING as ABHÖREN; foreign address 0.0.0.0:0
    // is the locale-independent listener signal.
    const stdout = [
      ...header,
      "  TCP    127.0.0.1:9222         0.0.0.0:0              ABHÖREN         19780",
    ].join("\r\n");

    expect(parseWindowsNetstatListeners(stdout, 19780)).toEqual([9222]);
  });

  it("handles IPv6 listeners", () => {
    const stdout = [
      ...header,
      "  TCP    [::1]:51822            [::]:0                 LISTENING       12476",
      "  TCP    [::]:9222              [::]:0                 LISTENING       12476",
    ].join("\r\n");

    expect(parseWindowsNetstatListeners(stdout, 12476)).toEqual([9222, 51822]);
  });

  it("ignores UDP rows and rows of other PIDs", () => {
    const stdout = [
      ...header,
      "  UDP    0.0.0.0:5050           *:*                                    19780",
      "  TCP    127.0.0.1:8080         0.0.0.0:0              LISTENING       4242",
    ].join("\r\n");

    expect(parseWindowsNetstatListeners(stdout, 19780)).toEqual([]);
  });

  it("returns an empty array for empty output", () => {
    expect(parseWindowsNetstatListeners("", 19780)).toEqual([]);
  });
});

describe("parseLsofListenPorts", () => {
  it("extracts ports from name field lines", () => {
    const stdout = ["p19780", "f23", "n127.0.0.1:9222", "f45", "n*:3928", ""].join("\n");

    expect(parseLsofListenPorts(stdout)).toEqual([3928, 9222]);
  });

  it("handles IPv6 addresses", () => {
    const stdout = ["p19780", "n[::1]:9222"].join("\n");

    expect(parseLsofListenPorts(stdout)).toEqual([9222]);
  });

  it("deduplicates ports bound on multiple interfaces", () => {
    const stdout = ["p19780", "n127.0.0.1:9222", "n[::1]:9222"].join("\n");

    expect(parseLsofListenPorts(stdout)).toEqual([9222]);
  });

  it("returns an empty array for empty output", () => {
    expect(parseLsofListenPorts("")).toEqual([]);
  });
});
