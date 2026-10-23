// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/// @title Def - reads a workflow definition's CORE bytes in memory
/// @notice Layout and rationale: packages/core/src/compile-evm.ts. All integers are big-endian; every offset
///         is absolute from byte 0 of CORE. `check` validates every offset and index once, when a definition
///         is registered, so the engine's reads afterwards stay inside CORE and inside the definition's own
///         tables.
library Def {
    error BadDefinition();

    uint256 internal constant VERSION = 2;
    uint256 internal constant HEADER = 12;
    uint256 internal constant NO_EXPR = 0xFFFF;

    // Step kinds (BPMN element types).
    uint256 internal constant START = 0;
    uint256 internal constant END = 1;
    uint256 internal constant USER = 2;
    uint256 internal constant SERVICE = 3;
    uint256 internal constant RECEIVE = 4;
    uint256 internal constant XOR = 5;
    uint256 internal constant AND = 6;
    uint256 internal constant CATCH = 7;

    // Field kinds.
    uint256 internal constant F_DECIMAL = 0;
    uint256 internal constant F_INT = 1;
    uint256 internal constant F_DATE = 2;
    uint256 internal constant F_TEXT = 3;
    uint256 internal constant F_PARTY = 4;
    uint256 internal constant F_BOOL = 5;

    // Capture sources.
    uint256 internal constant SRC_INPUT = 0;
    uint256 internal constant SRC_ORACLE = 1;
    uint256 internal constant SRC_EXPR = 2;

    // Asset operations.
    uint256 internal constant OP_NONE = 0;
    uint256 internal constant OP_MINT = 1;
    uint256 internal constant OP_BURN = 2;
    uint256 internal constant OP_TRANSFER = 3;
    uint256 internal constant OP_SWAP = 4;
    uint256 internal constant OP_DEPOSIT = 5;
    uint256 internal constant OP_DISTRIBUTE = 6;

    // Asset kinds.
    uint256 internal constant A_ISSUED = 0;
    uint256 internal constant A_CASH = 1;

    // Record sizes.
    uint256 internal constant STEP_FIXED = 10;
    uint256 internal constant DUE = 11;
    uint256 internal constant CAPTURE = 21;
    uint256 internal constant OP = 12;
    uint256 internal constant EDGE = 5;
    uint256 internal constant EXPR_OP = 11;

    /// A step record, located (offsets into CORE) but not copied.
    struct Step {
        uint256 kind;
        uint256 role;
        uint256 join;
        uint256 guard;
        uint256 nCaptures;
        uint256 nOps;
        uint256 nNext;
        uint256 nSends;
        uint256 timer; // offset of the timer Due, 0 = none
        uint256 until; // offset of the until Due, 0 = none
        uint256 captures;
        uint256 ops;
        uint256 next;
        uint256 sends;
    }

    function u8(bytes memory b, uint256 o) internal pure returns (uint256 v) {
        assembly {
            v := byte(0, mload(add(add(b, 32), o)))
        }
    }

    function u16(bytes memory b, uint256 o) internal pure returns (uint256 v) {
        assembly {
            v := shr(240, mload(add(add(b, 32), o)))
        }
    }

    function u32(bytes memory b, uint256 o) internal pure returns (uint256 v) {
        assembly {
            v := shr(224, mload(add(add(b, 32), o)))
        }
    }

    function i64(bytes memory b, uint256 o) internal pure returns (int256 v) {
        assembly {
            v := signextend(7, shr(192, mload(add(add(b, 32), o))))
        }
    }

    function nRoles(bytes memory c) internal pure returns (uint256) {
        return u8(c, 1);
    }

    function nFields(bytes memory c) internal pure returns (uint256) {
        return u8(c, 2);
    }

    function nAssets(bytes memory c) internal pure returns (uint256) {
        return u8(c, 3);
    }

    function nExprs(bytes memory c) internal pure returns (uint256) {
        return u16(c, 4);
    }

    function nSteps(bytes memory c) internal pure returns (uint256) {
        return u16(c, 6);
    }

    function coreLen(bytes memory c) internal pure returns (uint256) {
        return u32(c, 8);
    }

    function fieldKind(bytes memory c, uint256 f) internal pure returns (uint256) {
        return u8(c, HEADER + f);
    }

    function assetKind(bytes memory c, uint256 a) internal pure returns (uint256) {
        return u8(c, HEADER + nFields(c) + 2 * a);
    }

    function assetDecimals(bytes memory c, uint256 a) internal pure returns (uint256) {
        return u8(c, HEADER + nFields(c) + 2 * a + 1);
    }

    /// Offset of expression `e`'s program (its op count byte).
    function expr(bytes memory c, uint256 e) internal pure returns (uint256) {
        return u16(c, HEADER + nFields(c) + 2 * nAssets(c) + 2 * e);
    }

    function stepOffset(bytes memory c, uint256 i) internal pure returns (uint256) {
        return u16(c, HEADER + nFields(c) + 2 * nAssets(c) + 2 * nExprs(c) + 2 * i);
    }

    function step(bytes memory c, uint256 i) internal pure returns (Step memory s) {
        uint256 o = stepOffset(c, i);
        s.kind = u8(c, o);
        s.role = u8(c, o + 1);
        s.join = u8(c, o + 2);
        uint256 flags = u8(c, o + 3);
        s.guard = u16(c, o + 4);
        s.nCaptures = u8(c, o + 6);
        s.nOps = u8(c, o + 7);
        s.nNext = u8(c, o + 8);
        s.nSends = u8(c, o + 9);
        uint256 p = o + STEP_FIXED;
        if (flags & 1 != 0) {
            s.timer = p;
            p += DUE;
        }
        if (flags & 2 != 0) {
            s.until = p;
            p += DUE;
        }
        s.captures = p;
        s.ops = p + CAPTURE * s.nCaptures;
        s.next = s.ops + OP * s.nOps;
        s.sends = s.next + EDGE * s.nNext;
    }

    /// Validate a definition's CORE once, at registration: header, table bounds, and every index each step
    /// refers to. After this, reads by offset stay inside CORE and point at real roles, fields, assets,
    /// expressions and steps.
    function check(bytes memory c, uint256 maxRoles, uint256 maxFields, uint256 maxAssets) internal pure {
        uint256 len = c.length;
        if (len < HEADER || u8(c, 0) != VERSION || coreLen(c) != len) revert BadDefinition();
        uint256 roles = nRoles(c);
        uint256 fields = nFields(c);
        uint256 assets = nAssets(c);
        uint256 exprs = nExprs(c);
        uint256 steps = nSteps(c);
        if (roles == 0 || roles > maxRoles || fields > maxFields || assets > maxAssets) revert BadDefinition();
        if (steps == 0 || steps >= 0xFFFE) revert BadDefinition(); // 0xFFFE/0xFFFF are report sentinels
        uint256 tables = HEADER + fields + 2 * assets + 2 * exprs + 2 * steps;
        if (tables > len) revert BadDefinition();
        for (uint256 f = 0; f < fields; f++) {
            if (fieldKind(c, f) > F_BOOL) revert BadDefinition();
        }
        for (uint256 a = 0; a < assets; a++) {
            if (assetKind(c, a) > A_CASH || assetDecimals(c, a) > 36) revert BadDefinition();
        }
        for (uint256 e = 0; e < exprs; e++) {
            uint256 o = expr(c, e);
            if (o < tables || o + 1 > len) revert BadDefinition();
            uint256 n = u8(c, o);
            if (o + 1 + n * EXPR_OP > len) revert BadDefinition();
            for (uint256 k = 0; k < n; k++) {
                uint256 p = o + 1 + k * EXPR_OP;
                uint256 code = u8(c, p);
                if (code > 17 || (code == 1 && u16(c, p + 1) >= fields)) revert BadDefinition();
            }
        }
        for (uint256 i = 0; i < steps; i++) {
            uint256 o = stepOffset(c, i);
            if (o < tables || o + STEP_FIXED > len) revert BadDefinition();
            Step memory s = step(c, i);
            if (s.sends + 2 * s.nSends > len) revert BadDefinition();
            if (s.kind > CATCH || s.role >= roles) revert BadDefinition();
            if (s.guard != NO_EXPR && s.guard >= exprs) revert BadDefinition();
            if (s.timer != 0) _checkDue(c, s.timer, fields);
            if (s.until != 0) _checkDue(c, s.until, fields);
            for (uint256 k = 0; k < s.nCaptures; k++) {
                uint256 p = s.captures + k * CAPTURE;
                uint256 src = u8(c, p + 2);
                if (u16(c, p) >= fields || src > SRC_EXPR) revert BadDefinition();
                if (src == SRC_EXPR && u16(c, p + 3) >= exprs) revert BadDefinition();
            }
            for (uint256 k = 0; k < s.nOps; k++) {
                uint256 p = s.ops + k * OP;
                uint256 kind = u8(c, p);
                if (kind > OP_DISTRIBUTE) revert BadDefinition();
                if (kind == OP_NONE) continue;
                if (u8(c, p + 1) >= assets || u8(c, p + 2) >= roles || u8(c, p + 3) >= roles) revert BadDefinition();
                if (u16(c, p + 4) >= exprs) revert BadDefinition();
                if (kind == OP_SWAP || kind == OP_DISTRIBUTE) {
                    if (u8(c, p + 6) >= assets) revert BadDefinition();
                }
                if (kind == OP_SWAP) {
                    if (u8(c, p + 7) >= roles || u8(c, p + 8) >= roles || u16(c, p + 9) >= exprs) revert BadDefinition();
                }
            }
            for (uint256 k = 0; k < s.nNext; k++) {
                uint256 p = s.next + k * EDGE;
                uint256 cond = u16(c, p + 2);
                if (u16(c, p) >= steps || (cond != NO_EXPR && cond >= exprs)) revert BadDefinition();
            }
            for (uint256 k = 0; k < s.nSends; k++) {
                if (u16(c, s.sends + 2 * k) >= steps) revert BadDefinition();
            }
        }
    }

    function _checkDue(bytes memory c, uint256 o, uint256 fields) private pure {
        uint256 kind = u8(c, o);
        if (kind > 1 || (kind == 1 && u16(c, o + 9) >= fields)) revert BadDefinition();
    }
}
