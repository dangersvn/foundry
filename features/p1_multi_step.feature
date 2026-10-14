Feature: Multi-step formulas with questions, gates and decisions

  Background:
    Given a sample git repo with a passing test suite
    And Foundry is configured with the fake agent
    And the test pack "three-step" with steps "design", "build" and "check"

  Scenario: Steps run in dependency order
    When I start a run of "three-step"
    Then "build" starts only after "design" is done
    And "check" starts only after "build" is done

  Scenario: A step fans out per item of an earlier output
    Given the "design" step produces 3 units
    When I start a run of "three-step"
    Then 3 "build" items are created, one per unit

  Scenario: A question pauses the item until a person answers
    Given the fake agent asks "Which database?" with options "SQLite" and "Postgres"
    When I start a run of "three-step"
    Then the item is "waiting for input"
    And no agent session is running for it
    When I answer "SQLite"
    Then the next attempt receives the question and the answer in its envelope
    And the decision log records the answer with me as the actor

  Scenario: A rejected gate sends the work back with the comment
    Given the "design" step has a human gate
    When I start a run of "three-step"
    And I reject the "design" gate with comment "missing error cases"
    Then the next "design" attempt receives "missing error cases" in its envelope

  Scenario: Agent decisions are recorded with their rationale
    Given the fake agent submits a decision with alternatives, rationale and evidence
    When I start a run of "three-step"
    Then the decision log holds that decision linked to its item and step

  Scenario: A submission without a decisions list is rejected
    Given the fake agent submits a result with no decisions list
    When I start a run of "three-step"
    Then the submission fails schema validation
    And the item is not done

  Scenario: A step can be skipped with a reason
    Given the fake agent submits "skipped" for "check" with reason "no checks apply"
    When I start a run of "three-step"
    Then "check" is "skipped" and the reason is in the decision log
    And the run completes

  Scenario: A handoff reaches the next attempt
    Given the fake agent writes a handoff and then fails verification
    When I start a run of "three-step"
    Then the next attempt receives the handoff in its envelope

  Scenario: Review findings appear at the gate
    Given the "design" step has an advisory reviewer
    When I start a run of "three-step"
    Then the "design" gate shows the reviewer's findings

  Scenario: Parallel workers never collide
    Given the "design" step produces 6 units
    And Foundry runs 3 workers
    When I start a run of "three-step"
    Then no item is claimed twice
    And all "build" items finish

  Scenario: The refinery merges one change at a time
    Given two "build" items change the same lines of the same file
    When both pass verification
    Then the refinery merges one and sends the other back with the conflict
    And main passes the test suite after every merge

  Scenario: Any changed line traces back to its run
    When a run of "three-step" completes
    Then "foundry why" on a changed line shows its commit, item, decisions and run
