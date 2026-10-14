@real-agent
Feature: Real agents do the work

  Scenario Outline: The same item passes on each agent
    Given a sample git repo with a passing test suite
    And Foundry is configured with the "<agent>" agent
    When I run the one-step formula "add a health endpoint with a test"
    Then the item status is "done"
    And the test suite passes on main

    Examples:
      | agent  |
      | kiro   |
      | claude |
