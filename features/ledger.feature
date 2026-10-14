Feature: The ledger survives crashes and concurrency

  Background:
    Given a sample git repo with a passing test suite
    And Foundry is configured with the fake agent

  Scenario: Restart after a crash mid-run
    Given an item is running
    When Foundry is killed and restarted
    Then the item finishes as "done"
    And main has exactly one commit for the item

  Scenario: Two workers never claim the same item
    Given one ready item
    When two Foundry processes start at the same time
    Then exactly one of them claims the item

  Scenario: Every step is in the audit log
    When I run the one-step formula "add a health endpoint with a test"
    Then the log for the item lists claimed, agent started, tool call, verified and merged in that order

  Scenario: Errors name the layer and the next command
    Given the configured agent command does not exist
    When I run the one-step formula "add a health endpoint with a test"
    Then the error names the ACP runtime layer
    And the error suggests a command to run next
