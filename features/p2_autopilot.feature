Feature: In autopilot, roles resolve decision points and log every choice

  Background:
    Given a sample git repo with a passing test suite
    And Foundry is configured with the fake agent
    And the test pack "three-step" with steps "design", "build" and "check"

  Scenario: Manual mode still waits for a person
    Given the fake agent asks "Which database?" with options "SQLite" and "Postgres"
    When I start a run of "three-step" in "manual" mode
    Then the item is "waiting for input"

  Scenario: The answerer role answers a question with evidence
    Given the fake agent asks "Which database?" with options "SQLite" and "Postgres"
    And the answerer will answer "SQLite" citing the run's request
    When I start a run of "three-step" in "autopilot" mode
    Then the question is answered without a person
    And the decision log records the answer as a "decision" by the answerer role
    And the next attempt receives the question and the answer in its envelope

  Scenario: An answer without valid evidence is logged as an assumption
    Given the fake agent asks "Which database?" with options "SQLite" and "Postgres"
    And the answerer will answer "SQLite" citing an artifact that does not exist
    When I start a run of "three-step" in "autopilot" mode
    Then the decision log records the answer as an "assumption"

  Scenario: A role never answers its own question
    Given the answerer role asks a question during its own step
    When I start a run of "three-step" in "autopilot" mode
    Then the question is not resolved by the answerer role

  Scenario: The reviewer passes a gate after the verifiers
    Given the "design" step has a gate
    And the reviewer will approve
    When I start a run of "three-step" in "autopilot" mode
    Then the "design" gate passes without a person
    And the decision log records a "decision" by the reviewer role

  Scenario: A reviewer rejection sends the work back with its comment
    Given the "design" step has a gate
    And the reviewer will reject once with comment "missing error cases"
    When I start a run of "three-step" in "autopilot" mode
    Then the next "design" attempt receives "missing error cases" in its envelope

  Scenario: The resolver runs on a different agent than the author
    Given Foundry is configured with fake agents "kiro" and "claude"
    And the "design" step has a gate
    When I start a run of "three-step" in "autopilot" mode
    Then the agent that resolves the "design" gate differs from the agent that did "design"

  Scenario: A locked path waits for a person even in autopilot
    Given "payments/**" is a locked path
    And the "build" step changes "payments/charge.ts"
    When I start a run of "three-step" in "autopilot" mode
    Then the "build" gate waits for a person

  Scenario: Rejecting an assumption re-queues the work that relied on it
    Given an autopilot run that completed with an assumption used by "build"
    When I reject that assumption with comment "use Postgres"
    Then "build" is ready again
    And its next attempt receives "use Postgres" in its envelope

  Scenario: The kill switch returns control to a person
    Given an autopilot run with an item at a gate
    When I turn autopilot off
    Then that gate waits for a person
    And later decision points wait for a person
