import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pile_stroke_log/core/saved_projects_logic.dart';
import 'package:pile_stroke_log/screens/saved_projects_screen.dart';

void main() {
  testWidgets('Saved projects screen bootstraps with provider override',
      (WidgetTester tester) async {
    final projects = buildMockSavedProjects(
      userToken: 'demo_user',
      now: DateTime(2026, 3, 10, 9, 0),
    );

    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          savedProjectsProvider.overrideWith((ref) async => projects),
        ],
        child: const MaterialApp(
          home: SavedProjectsScreen(),
        ),
      ),
    );

    await tester.pumpAndSettle();

    expect(find.text('Saved Projects'), findsOneWidget);
    expect(find.text('Riverfront Expansion'), findsOneWidget);
    expect(find.text('Port Terminal Upgrade'), findsOneWidget);
  });
}
