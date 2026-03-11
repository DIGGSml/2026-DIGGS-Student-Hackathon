import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:pile_stroke_log/core/saved_projects_logic.dart';
import 'package:pile_stroke_log/screens/saved_projects_screen.dart';

void main() {
  testWidgets('Saved projects list and directory detail render mock data',
      (WidgetTester tester) async {
    final mockProjects = buildMockSavedProjects(
      userToken: 'demo_user',
      now: DateTime(2026, 3, 9, 10, 30),
    );

    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          savedProjectsProvider.overrideWith((ref) async => mockProjects),
        ],
        child: const MaterialApp(
          home: SavedProjectsScreen(),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Saved Projects'), findsOneWidget);
    expect(find.text('Riverfront Expansion'), findsOneWidget);
    expect(find.text('I-70 Overpass Retrofit'), findsOneWidget);
    expect(find.text('Port Terminal Upgrade'), findsOneWidget);

    await tester.tap(find.text('Riverfront Expansion'));
    await tester.pumpAndSettle();

    expect(find.text('Project Directory'), findsOneWidget);
    expect(find.text('Export All Projects (.zip)'), findsOneWidget);
    expect(
      find.text(
          '/storage/emulated/0/Download/PileStrokeLog/demo_user/Riverfront_Expansion_Pier_A_1'),
      findsOneWidget,
    );
    await tester.scrollUntilVisible(
      find.text('Riverfront_Expansion_PierA_1_030826_1015.pdf'),
      300,
      scrollable: find.byType(Scrollable).first,
    );
    await tester.pumpAndSettle();
    expect(
      find.text('Riverfront_Expansion_PierA_1_030826_1015.pdf'),
      findsOneWidget,
    );
    await tester.scrollUntilVisible(
      find.text('Riverfront_Expansion_PierA_1_030826_1015.xml'),
      300,
      scrollable: find.byType(Scrollable).first,
    );
    await tester.pumpAndSettle();
    expect(
      find.text('Riverfront_Expansion_PierA_1_030826_1015.xml'),
      findsOneWidget,
    );
  });
}
