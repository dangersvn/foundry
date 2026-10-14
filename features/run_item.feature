Feature: A work item goes from request to merged commit

  Background:
    Given a sample git repo with a passing test suite
    And Foundry is configured with the fake agent

  Scenario: One item is completed and merged
    When I run the one-step formula "add a health endpoint with a test"
    Then the item status is "done"
    And main has exactly one new commit for the item
    And the test suite passes on main

  Scenario: The agent cannot fake completion
    Given the fake agent reports success without making the test pass
    When I run the one-step formula "make the failing test pass"
    Then the item is not merged
    And the item shows the verifier failure

  Scenario: Agent edits stay in the item's worktree
    When I run the one-step formula "add a health endpoint with a test"
    Then main does not change before the merge step
