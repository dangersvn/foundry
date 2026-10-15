@real-agent @manual
Feature: The factory can measure itself and run on autopilot

  Scenario: A baseline exists for AI-DLC's Construction steps
    Given benchmark cases from the Phase 1 runs
    When I eval the current aidlc pack on the held-out set
    Then the baseline pass counts per Construction step are recorded

  Scenario: A hand-made improvement is proven, not assumed
    Given the weakest Construction step in the baseline
    When I change its prompt or step instructions and eval the change on the held-out set
    Then the new version is better with no case losing passes

  Scenario: A full run completes in autopilot
    Given a sample repo with a known bug and a failing test that shows it
    When I start an AI-DLC "bugfix" run in autopilot
    Then the run completes with the fix merged and every test passing
    And no person was asked anything outside locked areas
    And every answer and gate decision is in the decision log
    And I review the assumption list
