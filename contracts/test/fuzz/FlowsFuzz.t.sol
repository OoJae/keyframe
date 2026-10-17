// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IKeyframeEscrowFactory as IF} from "../../src/interfaces/IKeyframeEscrowFactory.sol";
import {KeyframeBase} from "../utils/KeyframeBase.sol";

/// @notice Money-split and timing properties over fuzzed amounts, funding levels and timestamps.
contract FlowsFuzzTest is KeyframeBase {
    function setUp() public {
        vm.warp(1_790_000_000);
        _deployLocal();
    }

    function testFuzz_register_validityWindow(uint256 amount, uint64 deadlineOffset) public {
        IF.Terms memory t = _instant(amount);
        t.deadline = uint64(block.timestamp + bound(deadlineOffset, 0, 60 days));
        bool valid = amount >= factory.MIN_AMOUNT() && amount <= factory.MAX_AMOUNT() && t.deadline > block.timestamp
            && t.deadline <= block.timestamp + 30 days;
        _fundEscrow(t, bound(amount, 0, 1e15));
        if (!valid) vm.expectRevert();
        factory.register(t);
    }

    function testFuzz_instantRelease_split(
        uint256 amount,
        uint256 extra,
        uint256 charge,
        uint32 lead,
        uint32 span,
        uint16 floorBps,
        uint32 at
    ) public {
        amount = bound(amount, factory.MIN_AMOUNT(), factory.MAX_AMOUNT());
        extra = bound(extra, 0, 100_000_000);
        IF.Terms memory t = _instant(amount);
        t.dueAt = uint64(block.timestamp + bound(lead, 1, 1 days));
        t.deadline = uint64(t.dueAt + bound(span, 1, 20 days));
        t.slaFloorBps = uint16(bound(floorBps, 0, 10_000));
        _fundEscrow(t, amount + extra);
        factory.register(t);

        vm.warp(bound(at, block.timestamp, t.deadline));
        uint256 max = factory.payoutAt(t, block.timestamp);
        charge = bound(charge, 0, amount);
        vm.prank(operator);
        if (charge > max) {
            vm.expectRevert(abi.encodeWithSelector(IF.ChargeTooHigh.selector, max));
            factory.release(t, KEY, charge, MANIFEST);
            return;
        }
        factory.release(t, KEY, charge, MANIFEST);
        assertEq(_bal(seller), charge);
        assertEq(_bal(buyer), amount + extra - charge);
        assertEq(_bal(_e(t)), 0);
        assertLe(_bal(seller), amount);
    }

    function testFuzz_instant_releaseXorRefundByTime(uint32 dt) public {
        IF.Terms memory t = _instant(1_000_000);
        _open(t);
        vm.warp(block.timestamp + bound(dt, 0, 2 hours));
        bool late = block.timestamp > t.deadline;
        vm.prank(operator);
        if (late) vm.expectRevert(abi.encodeWithSelector(IF.TooLate.selector, t.deadline));
        factory.release(t, KEY, 1_000_000, MANIFEST);
        if (!late) vm.expectRevert(abi.encodeWithSelector(IF.BadStatus.selector, uint8(IF.Status.Released)));
        factory.refund(t);
        assertEq(_bal(seller) + _bal(buyer), 1_000_000);
        assertEq(late ? _bal(buyer) : _bal(seller), 1_000_000);
    }

    function testFuzz_studio_rejectSplit(uint256 amount, uint16 killFeeBps, uint256 extra, uint32 at) public {
        amount = bound(amount, factory.MIN_AMOUNT(), factory.MAX_AMOUNT());
        killFeeBps = uint16(bound(killFeeBps, 0, factory.MAX_KILL_FEE_BPS()));
        extra = bound(extra, 0, 10_000_000);
        IF.Terms memory t = _studio(amount, 1 days, killFeeBps);
        _fundEscrow(t, amount + extra);
        factory.register(t);
        vm.prank(operator);
        factory.deliver(t, MANIFEST);
        vm.warp(block.timestamp + bound(at, 0, 1 days - 1));
        vm.prank(buyer);
        factory.decide(t, false);
        uint256 fee = amount * killFeeBps / 10_000;
        assertEq(_bal(seller), fee);
        assertEq(_bal(buyer), amount + extra - fee);
    }

    function testFuzz_studio_releaseWindow(uint32 dt, bool accept) public {
        IF.Terms memory t = _studio(10_000_000, 1 days, 0);
        _openDelivered(t);
        uint256 reviewEnd = block.timestamp + 1 days;
        if (accept) {
            vm.prank(buyer);
            factory.decide(t, true);
        }
        vm.warp(block.timestamp + bound(dt, 0, 5 days));
        bool ok = (accept || block.timestamp >= reviewEnd) && block.timestamp <= reviewEnd + 3 days;
        vm.prank(operator);
        if (!ok) vm.expectRevert();
        factory.release(t, KEY, 10_000_000, MANIFEST);
        // Exactly one of release / refund is ever possible at a given time.
        if (ok) {
            vm.expectRevert(abi.encodeWithSelector(IF.BadStatus.selector, uint8(IF.Status.Released)));
        } else if (block.timestamp <= reviewEnd + 3 days) {
            vm.expectRevert(abi.encodeWithSelector(IF.TooEarly.selector, reviewEnd + 3 days));
        }
        factory.refund(t);
    }
}
