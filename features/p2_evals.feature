Feature: Evals turn quality into numbers

  Background:
    Given a sample git repo with a passing test suite
    And Foundry is configured with the fake agent
    And a completed run of "three-step" with approved items

  Scenario: An approved item becomes a frozen benchmark case
    When I add an approved "build" item to the benchmark
    Then a case is written to benchmarks/ with its envelope, base commit, accepted output and verifier setup
    And the case is assigned to "dev" or "held-out"

  Scenario: The dev and held-out split is deterministic
    When I add the same item to the benchmark in two fresh setups
    Then it lands in the same split both times

  Scenario: Agents cannot change the benchmark
    Given an item whose change edits a file in benchmarks/
    When it reaches the refinery
    Then the refinery rejects it and names the protected path

  Scenario: Replay grades several trials from the frozen envelope
    Given a benchmark case for a "build" item
    When I replay the case with 3 trials
    Then each trial runs in a fresh lane from the case's base commit
    And the report shows passes out of 3

  Scenario: Eval compares two pack versions case by case
    Given pack version "a" where the fake agent passes 1 of 3 trials
    And pack version "b" where the fake agent passes 3 of 3 trials
    When I eval "a" against "b" on the held-out set
    Then the report shows pass counts per case for both versions
    And the verdict is that "b" is better

  Scenario: A version that loses passes on any case is not better
    Given pack version "b" gains passes on one case and loses passes on another
    When I eval "a" against "b" on the held-out set
    Then the verdict is that "b" is not better

  Scenario: Costly commands show their cost first
    When I eval "a" against "b" without confirming
    Then the number of agent sessions it would start is shown
    And no agent session starts

  Scenario: Agents can be compared role by role
    Given Foundry is configured with fake agents "kiro" and "claude"
    When I eval agents "kiro" and "claude" on the held-out set
    Then the report shows pass counts per role for each agent

  Scenario: Stats come from the event log
    When I ask for stats by role
    Then I see first-pass yield, attempts per item, human rejection rate, agent requests per merged item, escalation rate and assumption count for each role
