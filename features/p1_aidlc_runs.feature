@real-agent @manual
Feature: AI-DLC runs end to end through Foundry

  Scenario: A bugfix run
    Given a sample repo with a known bug and a failing test that shows it
    When I start an AI-DLC "bugfix" run and answer every question and gate
    Then the run completes with the fix merged and every test passing

  Scenario: A feature run
    Given a sample repo
    When I start an AI-DLC "feature" run for a small feature and answer every question and gate
    Then the run completes with the feature merged and its scenarios passing
    And "foundry why" traces a changed line to its stage, decisions and my answers
