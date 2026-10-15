Feature: Work is isolated in lanes that match how it builds

  Background:
    Given a sample git repo with a passing test suite
    And Foundry is configured with the fake agent
    And the test pack "plan-build" where each unit has a "plan" step then a "build" step

  Scenario: Steps of one unit share a lane
    Given the run produces 1 unit
    When I start a run of "plan-build"
    Then "plan" and "build" for that unit use the same worktree and branch
    And "build" sees the files "plan" wrote
    And the refinery merges the unit once

  Scenario: Different units get different lanes
    Given the run produces 2 units
    When I start a run of "plan-build"
    Then each unit has its own worktree and branch

  Scenario: A retry reuses the lane
    Given the fake agent fails verification once on "build"
    When I start a run of "plan-build"
    Then the second "build" attempt runs in the same worktree as the first

  Scenario: Document-only steps share the run's docs lane
    Given the pack has two document-only steps
    When I start a run of "plan-build"
    Then both document-only steps use one docs worktree for the run

  Scenario: Merged lanes are cleaned up and failed ones are kept
    Given one unit merges and another fails
    When the run ends
    Then the merged unit's worktree is removed
    And the failed unit's worktree is kept until "foundry gc"
